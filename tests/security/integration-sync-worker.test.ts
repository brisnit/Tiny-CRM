import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { encryptSecret } from "../../src/lib/crypto";
import { RetryAfterError } from "../../src/lib/jobs";
import {
  BACKFILL_WINDOW_DAYS,
  INCREMENTAL_OVERLAP_MS,
  MAX_BACKFILL_PAGES,
  MAX_INCREMENTAL_PAGES,
} from "../../src/lib/integrations/sync/graph";
import {
  MAX_RECOVERY_ATTEMPTS,
  runSyncPage,
  startBackfill,
  resumeBackfill,
  startIncremental,
} from "../../src/lib/integrations/sync/worker";
import { scheduleDueSyncs } from "../../src/lib/integrations/sync/schedule";
import type { Transport } from "../../src/lib/integrations/oauth-client";

/**
 * The sync chain: what it does between pages, and what it refuses to do.
 *
 * Every provider response here is a fake. Nothing contacts Graph, and a pass
 * says nothing about the live provider — the real sync is verified by hand
 * against the canary and reported separately.
 */
let tenant: Tenant;
let integrationId = "";

/** A token endpoint and a Graph endpoint in one fake. */
function provider(pages: Record<string, unknown>, options: { status?: Record<string, number>; headers?: Record<string, Record<string, string>> } = {}): Transport {
  return async (url: string) => {
    const key = Object.keys(pages).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ value: [] }), { status: 200 });
    const status = options.status?.[key] ?? 200;
    return new Response(JSON.stringify(pages[key]), {
      status,
      headers: { "content-type": "application/json", ...(options.headers?.[key] ?? {}) },
    });
  };
}

function graphMessages(ids: string[]) {
  return {
    value: ids.map((id) => ({
      id,
      conversationId: `t-${id}`,
      subject: `Subject ${id}`,
      bodyPreview: "…",
      receivedDateTime: new Date().toISOString(),
      from: { emailAddress: { address: "someone@client.test" } },
      toRecipients: [{ emailAddress: { address: "me@canary.test" } }],
    })),
  };
}

before(async () => {
  tenant = await createTenant("SyncWorker", { plan: "pro" });
});

after(async () => {
  await db.domainEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.emailMessage.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await cleanupTenants([tenant]);
  await db.$disconnect();
});

beforeEach(async () => {
  await db.domainEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.emailMessage.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  const row = await db.integration.create({
    data: {
      workspaceId: tenant.workspaceId,
      userId: tenant.ownerId,
      provider: "outlook",
      status: "connected",
      accountEmail: "me@canary.test",
      credentials: encryptSecret(
        JSON.stringify({
          accessToken: "fake-access-token",
          refreshToken: "fake-refresh-token",
          scope: "",
          obtainedAt: new Date().toISOString(),
        }),
        "integration-credentials",
      ),
      // Far in the future, so no refresh is attempted.
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      syncGeneration: 1,
      syncState: "backfilling",
    },
    select: { id: true },
  });
  integrationId = row.id;
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runAsTestIdentity(tenant.ownerId, () =>
    withTenantContext(
      { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
      fn,
    ),
  );

const queued = () =>
  db.domainEvent.count({ where: { workspaceId: tenant.workspaceId, name: "integration.sync" } });

describe("a rate limit is never retried sooner than the provider asked", () => {
  test("Retry-After becomes the floor on the retry, in milliseconds", async () => {
    const transport = provider(
      { "/me/messages": { error: "throttled" } },
      { status: { "/me/messages": 429 }, headers: { "/me/messages": { "retry-after": "300" } } },
    );
    let thrown: unknown;
    try {
      await asOwner(() => runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }));
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof RetryAfterError, `expected RetryAfterError, got ${String(thrown)}`);
    assert.equal(
      (thrown as RetryAfterError).retryAfterMs,
      300_000,
      "the provider's Retry-After was not carried through in milliseconds",
    );
  });

  test("a missing or nonsense Retry-After falls back to a sane wait, never zero", async () => {
    for (const header of [undefined, "", "soon", "-5", "0"]) {
      const transport = provider(
        { "/me/messages": { error: "throttled" } },
        {
          status: { "/me/messages": 429 },
          headers: { "/me/messages": header === undefined ? {} : { "retry-after": header } },
        },
      );
      let thrown: unknown;
      try {
        await asOwner(() => runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }));
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof RetryAfterError, `header ${JSON.stringify(header)} did not throttle`);
      assert.ok(
        (thrown as RetryAfterError).retryAfterMs >= 30_000,
        `header ${JSON.stringify(header)} produced a ${(thrown as RetryAfterError).retryAfterMs}ms wait`,
      );
    }
  });

  test("503 is throttled the same way, not treated as a hard failure", async () => {
    const transport = provider(
      { "/me/messages": { error: "unavailable" } },
      { status: { "/me/messages": 503 }, headers: { "/me/messages": { "retry-after": "120" } } },
    );
    await assert.rejects(
      () => asOwner(() => runSyncPage({ integrationId, generation: 1, cursor: null }, { transport })),
      (error: unknown) =>
        error instanceof RetryAfterError && error.retryAfterMs === 120_000,
    );
  });

  test("nothing was imported and the cursor did not move", async () => {
    const transport = provider(
      { "/me/messages": {} },
      { status: { "/me/messages": 429 }, headers: { "/me/messages": { "retry-after": "60" } } },
    );
    await asOwner(() =>
      runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }),
    ).catch(() => {});
    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { syncCursor: true, pagesImported: true },
    });
    assert.equal(after.syncCursor, null);
    assert.equal(after.pagesImported, 0, "a throttled page counted against the cap");
  });
});

describe("an expired cursor restarts the window without duplicating or exposing anything", () => {
  test("a 410 clears the cursor and queues a fresh start", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: { syncCursor: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=stale", pagesImported: 7 },
    });
    const transport = provider({ "$skiptoken=stale": { error: "gone" } }, { status: { "$skiptoken=stale": 410 } });

    const result = await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=stale" },
        { transport },
      ),
    );
    assert.equal(result.done, false, "an expired cursor ended the sync instead of restarting it");

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { syncCursor: true, pagesImported: true, backfillTruncated: true },
    });
    assert.equal(after.syncCursor, null, "the dead cursor was kept");
    assert.equal(after.pagesImported, 0, "the restart did not get a fresh budget");
    assert.equal(after.backfillTruncated, false);
    assert.equal(await queued(), 1, "no fresh start was queued");
  });

  test("re-reading after a restart imports nothing twice", async () => {
    // The window overlaps what was already imported, which is the whole point:
    // de-duplication is on (workspace, owner, provider, externalId), so a
    // restart is safe rather than merely tolerable.
    const first = provider({ "/me/messages": graphMessages(["a", "b", "c"]) });
    await asOwner(() => runSyncPage({ integrationId, generation: 1, cursor: null }, { transport: first }));
    assert.equal(await db.emailMessage.count({ where: { workspaceId: tenant.workspaceId } }), 3);

    const again = provider({ "/me/messages": graphMessages(["a", "b", "c", "d"]) });
    const result = await asOwner(() =>
      runSyncPage({ integrationId, generation: 1, cursor: null }, { transport: again }),
    );
    assert.equal(result.imported, 1, "the restart re-imported messages it already had");
    assert.equal(result.duplicates, 3);
    assert.equal(
      await db.emailMessage.count({ where: { workspaceId: tenant.workspaceId } }),
      4,
      "a restart duplicated messages",
    );
  });

  test("rows that survive a restart keep their owner, privacy and provenance", async () => {
    const transport = provider({ "/me/messages": graphMessages(["keep-1", "keep-2"]) });
    await asOwner(() => runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }));

    await asOwner(() => runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }));

    const rows = await db.emailMessage.findMany({
      where: { workspaceId: tenant.workspaceId },
      select: { visibility: true, ownerUserId: true, source: true },
    });
    assert.equal(rows.length, 2, "the restart changed the row count");
    for (const row of rows) {
      assert.equal(row.visibility, "private", "a restart made a message workspace-visible");
      assert.equal(row.ownerUserId, tenant.ownerId, "a restart changed ownership");
      assert.equal(row.source, "imported", "a restart lost provenance, making it AI-eligible");
    }
  });
});

describe("the page cap belongs to the backfill, not to one job", () => {
  test("the budget is shared across chained jobs and is not reset by continuing", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: { pagesImported: MAX_BACKFILL_PAGES - 2 },
    });
    const withNext = {
      ...graphMessages(["p1"]),
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next",
    };
    const transport = provider({ "/me/messages": withNext });

    // One page short of the cap: continues, and the budget advances.
    const first = await asOwner(() =>
      runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }),
    );
    assert.equal(first.truncated, false);
    assert.equal(first.done, false, "the chain stopped early");
    assert.equal(
      (await db.integration.findUniqueOrThrow({ where: { id: integrationId }, select: { pagesImported: true } }))
        .pagesImported,
      MAX_BACKFILL_PAGES - 1,
      "a continued job reset the shared budget",
    );

    // The next job in the same chain hits the cap.
    const second = await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next" },
        { transport },
      ),
    );
    assert.equal(second.truncated, true, "the cap did not apply across jobs");
    assert.equal(second.done, true, "a capped backfill kept going");

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { backfillTruncated: true, syncCursor: true, backfillCompletedAt: true },
    });
    assert.equal(after.backfillTruncated, true, "an incomplete import was not reported as incomplete");
    assert.ok(after.syncCursor, "the cursor was discarded, so resume would start over");
    assert.ok(after.backfillCompletedAt, "the backfill did not stop");
  });

  test("a new connection resets the budget, because it is a new attempt", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: { pagesImported: MAX_BACKFILL_PAGES, backfillTruncated: true },
    });
    await asOwner(() =>
      startBackfill({
        integrationId,
        workspaceId: tenant.workspaceId,
        ownerUserId: tenant.ownerId,
        generation: 1,
      }),
    );
    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { pagesImported: true, backfillTruncated: true, syncCursor: true },
    });
    assert.equal(after.pagesImported, 0);
    assert.equal(after.backfillTruncated, false);
    assert.equal(after.syncCursor, null);
    assert.equal(await queued(), 1, "a backfill was started without queueing a page");
  });

  test("resuming keeps the cursor and clears the incomplete flag", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: {
        pagesImported: MAX_BACKFILL_PAGES,
        backfillTruncated: true,
        syncCursor: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=resume",
        importedThrough: new Date("2026-09-20T00:00:00Z"),
      },
    });
    const result = await asOwner(() =>
      resumeBackfill({ integrationId, workspaceId: tenant.workspaceId, ownerUserId: tenant.ownerId }),
    );
    assert.equal(result.resumed, true);

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { pagesImported: true, backfillTruncated: true, syncCursor: true, importedThrough: true },
    });
    assert.equal(after.syncCursor, "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=resume",
      "resume lost the cursor and would start the window again");
    assert.equal(after.pagesImported, 0, "resume did not get a fresh budget");
    assert.equal(after.backfillTruncated, false);
    assert.equal(
      after.importedThrough?.toISOString(),
      "2026-09-20T00:00:00.000Z",
      "resume forgot how far the previous attempt reached",
    );
    assert.equal(await queued(), 1);
  });

  test("resume refuses when there is nothing to resume", async () => {
    const result = await asOwner(() =>
      resumeBackfill({ integrationId, workspaceId: tenant.workspaceId, ownerUserId: tenant.ownerId }),
    );
    assert.equal(result.resumed, false, "a complete backfill was resumed");
    assert.equal(await queued(), 0, "a job was queued for nothing");
  });
});

describe("the chain stops when the connection does", () => {
  test("a stale generation stands down without importing or queueing", async () => {
    const transport = provider({ "/me/messages": graphMessages(["x"]) });
    const result = await asOwner(() =>
      runSyncPage({ integrationId, generation: 0, cursor: null }, { transport }),
    );
    assert.equal(result.done, true);
    assert.equal(result.imported, 0);
    assert.equal(await db.emailMessage.count({ where: { workspaceId: tenant.workspaceId } }), 0);
    assert.equal(await queued(), 0, "a stale chain queued more work");
  });

  test("a disconnected connection stands down", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: { status: "disconnected", credentials: null },
    });
    const transport = provider({ "/me/messages": graphMessages(["x"]) });
    const result = await asOwner(() =>
      runSyncPage({ integrationId, generation: 1, cursor: null }, { transport }),
    );
    assert.equal(result.done, true);
    assert.equal(await queued(), 0, "a disconnected connection queued more work");
  });
});

describe("the runner, not just the handler, respects Retry-After", () => {
  /**
   * The tests above prove the handler asks for a delay. This proves the queue
   * grants it — which is the actual requirement, and a different piece of
   * code. Without this, a correct handler and a runner that ignored
   * `RetryAfterError` would still retry in two seconds and every assertion
   * above would pass.
   *
   * The rule is one line of arithmetic — the delay is
   * `max(ordinary backoff, Retry-After)` — so these assert that equality
   * rather than a range around it. A range is what the first version of this
   * did, and it was unsound: the first attempt's backoff is 4s jittered by
   * ±25%, i.e. anywhere in 3000–5000ms, and an assertion of `>= 3500ms` failed
   * roughly one CI run in four. Pinning the jitter removes the guesswork
   * instead of widening the window until it stops failing.
   */

  /**
   * Jitter of 0.5 is the midpoint of the ±25% band, so `0.75 + 0.5 × 0.5 = 1`
   * and the backoff is exactly its base: 4000ms on the first attempt. The
   * formula, the ceiling and the spread are production's — only the draw is
   * fixed. Asserted below rather than assumed.
   */
  const PINNED_BACKOFF_MS = 4_000;

  beforeEach(async () => {
    const { setBackoffJitterForTests, backoffMs } = await import("../../src/lib/jobs");
    setBackoffJitterForTests(() => 0.5);
    assert.equal(
      backoffMs(1),
      PINNED_BACKOFF_MS,
      "the pinned backoff is not what these tests compute against",
    );
  });

  after(async () => {
    const { setBackoffJitterForTests, installedBackoffJitterForTests } = await import(
      "../../src/lib/jobs"
    );
    setBackoffJitterForTests(null);
    assert.equal(installedBackoffJitterForTests(), null, "the jitter seam leaked out of this file");
  });

  /**
   * Runs one job to its retry and returns the delay the runner scheduled.
   *
   * `availableAt` is written as `now + delay` from inside the run, so the
   * instant it was computed is unknown but bracketed by the run. Returning the
   * bracket lets a caller assert the delay exactly, to within how long the run
   * took — which is milliseconds, against figures seconds apart.
   */
  async function scheduledDelay(failure: Error): Promise<{ min: number; max: number; status: string }> {
    const { registerHandler, runJobs } = await import("../../src/lib/jobs");
    const { emitEvent } = await import("../../src/lib/events");

    registerHandler("integration.sync", async () => {
      throw failure;
    });

    const event = await asOwner(() =>
      emitEvent({
        workspaceId: tenant.workspaceId,
        name: "integration.sync",
        entityType: "integration",
        entityId: integrationId,
        actorId: tenant.ownerId,
        payload: { integrationId, generation: 1, cursor: null },
      }),
    );

    const before = Date.now();
    await runJobs(5);
    const ranUntil = Date.now();

    const row = await db.domainEvent.findUniqueOrThrow({
      where: { id: event.id },
      select: { status: true, availableAt: true },
    });
    const scheduledAt = row.availableAt.getTime();
    // The delay is somewhere in [scheduledAt - ranUntil, scheduledAt - before].
    return { min: scheduledAt - ranUntil, max: scheduledAt - before, status: row.status };
  }

  function assertDelayEquals(
    scheduled: { min: number; max: number },
    expected: number,
    what: string,
  ): void {
    assert.ok(
      scheduled.min <= expected && expected <= scheduled.max,
      `${what}: expected a delay of exactly ${expected}ms, but the runner scheduled one in ` +
        `[${scheduled.min}, ${scheduled.max}]ms`,
    );
  }

  test("a Retry-After longer than our backoff is granted in full", async () => {
    // 300_000 > 4_000, so max() must take the provider's figure.
    const scheduled = await scheduledDelay(new RetryAfterError(300_000, "the provider asked for 300s"));
    assert.equal(scheduled.status, "failed", "the job did not record a retryable failure");
    assertDelayEquals(scheduled, 300_000, "a 300s Retry-After above our 4s backoff");
  });

  test("a Retry-After shorter than our backoff does not pull the retry closer", async () => {
    // 1_000 < 4_000, so max() must keep *our* figure. Mutation found this gap:
    // replacing the backoff with Retry-After, rather than taking the later of
    // the two, passed every other test here because the provider's figure was
    // always the larger one. A provider asking for one second must not get a
    // retry in one second when our own backoff says longer — that is how a
    // struggling provider gets hammered. With the jitter pinned, a replacement
    // schedules 1000ms where this demands 4000ms, which no jitter draw can
    // disguise.
    const scheduled = await scheduledDelay(new RetryAfterError(1_000, "the provider asked for 1s"));
    assert.equal(scheduled.status, "failed", "the job did not record a retryable failure");
    assertDelayEquals(scheduled, PINNED_BACKOFF_MS, "a 1s Retry-After below our 4s backoff");
  });

  test("an ordinary failure still uses the ordinary backoff", async () => {
    // The control: if RetryAfterError simply made every retry five minutes,
    // the tests above would pass for the wrong reason.
    const scheduled = await scheduledDelay(new Error("an ordinary transient failure"));
    assertDelayEquals(scheduled, PINNED_BACKOFF_MS, "a failure carrying no Retry-After");
  });
});

describe("the incremental pass, which is what keeps a mailbox current", () => {
  /**
   * None of this existed. Connecting ran a bounded backfill and the chain
   * carried itself to the end of its window; after that a mailbox went quiet
   * forever. `deltaStartUrl()` was written but had no callers, `deltaLink` was
   * parsed and discarded, `importPage`'s `incremental` flag was never set by
   * anybody, and nothing anywhere enqueued a second pass. The canary showed it
   * as 320 messages imported and then nothing, which looks identical to a
   * mailbox that received no new mail.
   */

  /** Puts the connection where a finished backfill leaves it. */
  async function backfilled(lastSyncAt: Date): Promise<void> {
    await db.integration.update({
      where: { id: integrationId },
      data: {
        syncState: "idle",
        backfillCompletedAt: new Date(Date.now() - 86_400_000),
        backfillTruncated: false,
        pagesImported: 7,
        syncCursor: null,
        lastSyncAt,
      },
    });
  }

  /** Records the URLs a run asked Graph for, so the window can be asserted. */
  function recordingProvider(pages: Record<string, unknown>[]): {
    transport: Transport;
    urls: string[];
  } {
    const urls: string[] = [];
    let call = 0;
    const transport: Transport = async (url: string) => {
      urls.push(url);
      const body = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { transport, urls };
  }

  test("an incremental pass reads from lastSyncAt, with an overlap, not from the window start", async () => {
    const lastSyncAt = new Date(Date.now() - 3 * 86_400_000);
    await backfilled(lastSyncAt);

    const { transport, urls } = recordingProvider([graphMessages(["inc-1"])]);
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport },
      ),
    );

    assert.equal(urls.length, 1);
    const asked = new URL(urls[0]!);
    const filter = asked.searchParams.get("$filter") ?? "";
    const match = /receivedDateTime ge (.+)$/.exec(filter);
    assert.ok(match, `the incremental pass did not filter on receivedDateTime: ${filter}`);

    const from = new Date(match[1]!).getTime();
    assert.equal(
      from,
      lastSyncAt.getTime() - INCREMENTAL_OVERLAP_MS,
      "the incremental window did not start one overlap before the last sync",
    );
    // The thing that would make this pointless: reading the 30-day window again.
    const windowStart = Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000;
    assert.ok(
      from > windowStart,
      "the incremental pass re-read the whole backfill window instead of only new mail",
    );
  });

  test("an incremental pass does not spend the backfill's page budget", async () => {
    await backfilled(new Date(Date.now() - 3 * 86_400_000));
    const { transport } = recordingProvider([graphMessages(["inc-a"])]);
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport },
      ),
    );
    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { pagesImported: true },
    });
    assert.equal(
      after.pagesImported,
      7,
      "an incremental page was charged to the backfill's budget, which would exhaust it over time",
    );
  });

  test("a multi-page incremental pass does not erase the completed backfill", async () => {
    /**
     * The defect this was written for: `importPage` wrote
     * `backfillCompletedAt: null` on every page that had a next page. On a
     * backfill that is correct — it is still running. On an incremental pass
     * it reopens a backfill that finished weeks ago, and `startIncremental`
     * refuses to schedule a connection whose backfill has not completed, so
     * the connection would never sync again. A single-page incremental pass
     * would not have caught it; it takes a second page.
     */
    await backfilled(new Date(Date.now() - 3 * 86_400_000));
    const completedBefore = (
      await db.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { backfillCompletedAt: true },
      })
    ).backfillCompletedAt;

    const withNext = {
      ...graphMessages(["inc-p1"]),
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next",
    };
    const { transport } = recordingProvider([withNext]);
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport },
      ),
    );

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { backfillCompletedAt: true, backfillTruncated: true, syncState: true },
    });
    assert.deepEqual(
      after.backfillCompletedAt,
      completedBefore,
      "an incremental page reopened a backfill that had already finished",
    );
    assert.equal(after.backfillTruncated, false, "an incremental page set the truncation flag");
    assert.equal(after.syncState, "syncing", "a running incremental chain reported the wrong state");
  });

  test("the overlap re-reads mail without duplicating it or changing who owns it", async () => {
    await backfilled(new Date(Date.now() - 3 * 86_400_000));
    const page = graphMessages(["overlap-1", "overlap-2"]);

    const first = await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport: recordingProvider([page]).transport },
      ),
    );
    assert.equal(first.imported, 2);

    // The next pass overlaps the previous one by design.
    const second = await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport: recordingProvider([page]).transport },
      ),
    );
    assert.equal(second.imported, 0, "the overlap imported the same mail twice");
    assert.equal(second.duplicates, 2, "the overlap was not recognised as already imported");

    const rows = await db.emailMessage.findMany({
      where: { integrationId },
      select: { visibility: true, ownerUserId: true, source: true },
    });
    assert.equal(rows.length, 2, "re-reading the overlap created extra rows");
    assert.ok(
      rows.every((r) => r.visibility === "private" && r.ownerUserId === tenant.ownerId && r.source === "imported"),
      "an incrementally imported message lost its privacy, owner or provenance",
    );
  });

  test("the incremental chain is bounded, and leaves no connection stuck syncing", async () => {
    await backfilled(new Date(Date.now() - 3 * 86_400_000));
    const withNext = {
      ...graphMessages(["cap-1"]),
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=more",
    };
    const { transport } = recordingProvider([withNext]);

    // One short of the cap: this page is the last one allowed.
    const result = await asOwner(() =>
      runSyncPage(
        {
          integrationId,
          generation: 1,
          cursor: null,
          mode: "incremental",
          page: MAX_INCREMENTAL_PAGES - 1,
        },
        { transport },
      ),
    );

    assert.equal(result.done, true, "the incremental chain continued past its cap");
    assert.equal(await queued(), 0, "a capped incremental chain queued more work");
    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { syncState: true },
    });
    assert.equal(
      after.syncState,
      "idle",
      "a capped chain left the connection reporting 'syncing', which blocks every future pass",
    );
  });

  test("startIncremental refuses what it should and queues what it should", async () => {
    const start = () =>
      asOwner(() =>
        startIncremental({
          integrationId,
          workspaceId: tenant.workspaceId,
          ownerUserId: tenant.ownerId,
        }),
      );

    // Backfill still running.
    await db.integration.update({
      where: { id: integrationId },
      data: { syncState: "backfilling", backfillCompletedAt: null, lastSyncAt: new Date() },
    });
    assert.equal((await start()).queued, false, "scheduled a connection mid-backfill");

    // Backfill stopped at the cap: resume is the right action, not a new pass.
    await db.integration.update({
      where: { id: integrationId },
      data: { syncState: "idle", backfillCompletedAt: new Date(), backfillTruncated: true },
    });
    assert.equal((await start()).queued, false, "scheduled a connection whose import is incomplete");

    // Disconnected.
    await db.integration.update({
      where: { id: integrationId },
      data: { backfillTruncated: false, status: "disconnected" },
    });
    assert.equal((await start()).queued, false, "scheduled a disconnected connection");

    // Ready.
    await db.integration.update({
      where: { id: integrationId },
      data: { status: "connected" },
    });
    const ok = await start();
    assert.equal(ok.queued, true, `a ready connection was not scheduled: ${ok.reason}`);
    assert.equal(await queued(), 1);
    const event = await db.domainEvent.findFirstOrThrow({
      where: { name: "integration.sync", entityId: integrationId },
      select: { payload: true },
    });
    const payload = JSON.parse(event.payload) as { mode?: string; cursor?: string | null };
    assert.equal(payload.mode, "incremental", "the scheduled pass was not an incremental one");
    assert.equal(payload.cursor, null);

    // And it must not queue a second one on top of the first.
    assert.equal((await start()).queued, false, "scheduled a second pass over a running one");
    assert.equal(await queued(), 1, "a duplicate incremental pass was queued");
  });

  test("the pass survives the queue: a scheduled job still runs as incremental", async () => {
    /**
     * The gap every other test in this file had. They all call `runSyncPage`
     * directly with `mode: "incremental"`, which skips the one hop a real
     * pass actually makes: scheduler -> DomainEvent -> the registered job
     * handler -> runSyncPage. That handler rebuilt the payload from three
     * named fields and dropped the rest, so `mode` and `page` never arrived
     * and every scheduled pass ran as a backfill — re-reading the whole
     * 30-day window, spending the backfill's page budget and rewriting
     * backfillCompletedAt. Found by running one real pass against the canary
     * mailbox, not here.
     *
     * So this uses the REAL handler and fakes only `fetch`. Registering a
     * stand-in handler here, which was the first thing I wrote, puts the
     * fake on exactly the line that was broken and the test passes either
     * way — it has to stub below the handler, not above it.
     */
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    const { runJobs } = await import("../../src/lib/jobs");
    const { scheduleDueSyncs } = await import("../../src/lib/integrations/sync/schedule");

    const completedAt = new Date(Date.now() - 86_400_000);
    await db.integration.update({
      where: { id: integrationId },
      data: {
        status: "connected",
        syncState: "idle",
        backfillCompletedAt: completedAt,
        backfillTruncated: false,
        pagesImported: 7,
        lastSyncAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });

    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://graph.microsoft.com/")) {
        urls.push(url);
        return new Response(JSON.stringify(graphMessages(["queued-1"])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      registerJobHandlers();
      const scheduled = await scheduleDueSyncs({ idleMs: 0 });
      assert.equal(scheduled.queued, 1, "the scheduler queued nothing to run");
      const ran = await runJobs(10);
      assert.equal(ran.failed + ran.dead, 0, "the scheduled job did not complete");
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(urls.length, 1, "the scheduled job did not fetch exactly one page");
    const filter = new URL(urls[0]!).searchParams.get("$filter") ?? "";
    assert.ok(
      /receivedDateTime ge/.test(filter),
      `a scheduled pass asked for the backfill window, not new mail: ${urls[0]}`,
    );
    // The backfill window reaches 30 days back; an incremental one reaches to
    // lastSyncAt, two hours ago. Which of the two it asked for is the whole
    // question, so it is asserted rather than inferred from the filter's shape.
    const from = new Date(/receivedDateTime ge (.+)$/.exec(filter)![1]!).getTime();
    assert.ok(
      from > Date.now() - 24 * 3_600_000,
      "a scheduled pass read from the backfill window start, so `mode` was lost in the queue",
    );

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { pagesImported: true, backfillCompletedAt: true },
    });
    assert.equal(
      after.pagesImported,
      7,
      "a scheduled incremental pass spent the backfill's page budget, so it ran as a backfill",
    );
    assert.equal(
      after.backfillCompletedAt?.getTime(),
      completedAt.getTime(),
      "a scheduled incremental pass rewrote the completed backfill",
    );
  });

  test("the scheduler queues connections that are behind and leaves fresh ones alone", async () => {
    const { scheduleDueSyncs } = await import("../../src/lib/integrations/sync/schedule");

    // Fresh: synced a minute ago.
    await db.integration.update({
      where: { id: integrationId },
      data: {
        status: "connected",
        syncState: "idle",
        backfillCompletedAt: new Date(Date.now() - 86_400_000),
        backfillTruncated: false,
        lastSyncAt: new Date(Date.now() - 60_000),
      },
    });
    const fresh = await scheduleDueSyncs({ idleMs: 30 * 60_000 });
    assert.equal(fresh.queued, 0, "a connection synced a minute ago was scheduled again");

    // Behind: synced two hours ago.
    await db.integration.update({
      where: { id: integrationId },
      data: { lastSyncAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    const behind = await scheduleDueSyncs({ idleMs: 30 * 60_000 });
    assert.equal(behind.queued, 1, "a connection two hours behind was not scheduled");
    assert.equal(await queued(), 1);

    // Having been scheduled, it is no longer idle, so the next tick skips it.
    const again = await scheduleDueSyncs({ idleMs: 30 * 60_000 });
    assert.equal(again.queued, 0, "the scheduler queued a second pass over a running one");
  });
});

describe("a sync chain that stopped is recovered, a bounded number of times", () => {
  /**
   * Recovery exists because a chain can stop with nothing wrong with the
   * connection: a job dead-letters after exhausting its attempts, or a worker
   * dies between the page transaction committing and the next page being
   * enqueued. Either leaves the row saying `syncing`, and `startIncremental`
   * refuses anything not `idle` — so the scheduler skipped it on every tick,
   * forever, while Settings still said "Connected".
   *
   * Under PostgreSQL every scan here goes through `app_due_integrations`
   * (prisma/postgres/018), so these run against the real function and the
   * real policy rather than an ordinary query.
   */
  const STALE = 4 * 30 * 60_000;

  /** Puts the connection mid-chain and stale, as an interrupted one is. */
  async function interrupted(
    state: "syncing" | "backfilling" = "syncing",
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await db.integration.update({
      where: { id: integrationId },
      data: {
        status: "connected",
        syncState: state,
        backfillCompletedAt: new Date(Date.now() - 7 * 86_400_000),
        backfillTruncated: false,
        pagesImported: 7,
        recoveryAttempts: 0,
        lastSyncAt: new Date(Date.now() - STALE - 60_000),
        ...overrides,
      },
    });
  }

  /** A queue row for this connection, in a given state. */
  async function job(status: string): Promise<void> {
    await db.domainEvent.create({
      data: {
        workspaceId: tenant.workspaceId,
        name: "integration.sync",
        entityType: "integration",
        entityId: integrationId,
        actorId: tenant.ownerId,
        payload: JSON.stringify({ integrationId, generation: 1, cursor: null, mode: "incremental" }),
        status,
      },
    });
  }

  const schedule = () => scheduleDueSyncs({ idleMs: 0, staleMs: STALE });

  test("an interrupted chain with no job left is recovered", async () => {
    await interrupted();
    const result = await schedule();
    assert.equal(result.recovered, 1, "a connection stuck mid-chain was not recovered");

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { syncState: true, recoveryAttempts: true, syncGeneration: true },
    });
    assert.equal(after.syncState, "syncing");
    assert.equal(after.recoveryAttempts, 1, "the recovery was not counted, so it is not bounded");
    assert.equal(after.syncGeneration, 1, "recovery moved the generation");

    const queuedJobs = await db.domainEvent.findMany({
      where: { name: "integration.sync", entityId: integrationId },
      select: { payload: true },
    });
    assert.equal(queuedJobs.length, 1, "recovery did not queue exactly one pass");
    const payload = JSON.parse(queuedJobs[0]!.payload) as {
      mode?: string; cursor?: string | null; generation?: number;
    };
    assert.equal(payload.mode, "incremental");
    assert.equal(payload.cursor, null, "a recovered chain resumed a cursor it should not trust");
    assert.equal(payload.generation, 1, "the recovered job carries a generation the row will refuse");
  });

  test("a dead-lettered chain is recovered", async () => {
    await interrupted();
    await job("dead");
    const result = await schedule();
    assert.equal(result.recovered, 1, "a dead-lettered chain was not recovered");
    assert.equal(
      await db.domainEvent.count({
        where: { name: "integration.sync", entityId: integrationId, status: "pending" },
      }),
      1,
      "no fresh pass was queued for the dead-lettered connection",
    );
  });

  for (const status of ["pending", "failed", "processing"]) {
    test(`a connection with a ${status} job is left alone`, async () => {
      // The queue still owns it. Restarting would run two chains against one
      // cursor and one page budget. `failed` is a job waiting out its
      // backoff — retrying, not stopped — and `processing` whose worker died
      // is reclaimed by app_claim_jobs, not by this.
      await interrupted();
      await job(status);
      const result = await schedule();
      assert.equal(result.recovered, 0, `a connection with a ${status} job was restarted`);
      assert.equal(result.queued, 0);

      const after = await db.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { syncState: true, recoveryAttempts: true },
      });
      assert.equal(after.recoveryAttempts, 0, "an attempt was counted against a live chain");
      assert.equal(
        await db.domainEvent.count({
          where: { name: "integration.sync", entityId: integrationId },
        }),
        1,
        "a second job was queued alongside the live one",
      );
    });
  }

  test("a chain that is merely in progress is not yet stale", async () => {
    // Mid-chain and recent. Indistinguishable from a stopped one except by
    // age, which is why the threshold exists.
    await interrupted("syncing", { lastSyncAt: new Date(Date.now() - 60_000) });
    const result = await schedule();
    assert.equal(result.recovered, 0, "a chain that started a minute ago was treated as stopped");
  });

  test("recovery stops at the cap, and does not keep queueing", async () => {
    await interrupted("syncing", { recoveryAttempts: MAX_RECOVERY_ATTEMPTS - 1 });
    const last = await schedule();
    assert.equal(last.recovered, 1, "the final permitted recovery did not happen");
    assert.equal(
      (await db.integration.findUniqueOrThrow({
        where: { id: integrationId }, select: { recoveryAttempts: true },
      })).recoveryAttempts,
      MAX_RECOVERY_ATTEMPTS,
    );

    // Now at the cap. Put it back mid-chain with no live job: the scan must
    // decline it from here on rather than recovering forever.
    await db.domainEvent.deleteMany({ where: { name: "integration.sync", entityId: integrationId } });
    await db.integration.update({
      where: { id: integrationId },
      data: { syncState: "syncing", lastSyncAt: new Date(Date.now() - STALE - 60_000) },
    });
    const beyond = await schedule();
    assert.equal(beyond.recovered, 0, "recovery continued past its bound");
    assert.equal(beyond.considered, 0, "the exhausted connection was still being considered");
    assert.equal(
      await db.domainEvent.count({ where: { name: "integration.sync", entityId: integrationId } }),
      0,
      "a pass was queued for a connection that had exhausted recovery",
    );
  });

  test("a pass that completes clears the count, so bad days do not accumulate", async () => {
    await interrupted("syncing", { recoveryAttempts: 2, lastSyncAt: new Date(Date.now() - 3 * 86_400_000) });
    const transport = provider({ "/me/messages": graphMessages(["after-recovery"]) });
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport },
      ),
    );
    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { recoveryAttempts: true, syncState: true },
    });
    assert.equal(after.recoveryAttempts, 0, "a completed pass did not clear the recovery count");
    assert.equal(after.syncState, "idle");
  });

  for (const [label, data] of [
    ["disconnected", { status: "disconnected" }],
    ["errored", { status: "error" }],
    ["needing reauthentication", { status: "reauth_required" }],
    ["demonstration data", { status: "mock" }],
    ["stopped at the page cap", { backfillTruncated: true }],
    ["still backfilling for the first time", { backfillCompletedAt: null }],
  ] as const) {
    test(`a connection that is ${label} is never restarted`, async () => {
      await interrupted("syncing", data as Record<string, unknown>);
      const result = await schedule();
      assert.equal(result.recovered, 0, `a connection that is ${label} was restarted`);
      assert.equal(
        await db.domainEvent.count({ where: { name: "integration.sync", entityId: integrationId } }),
        0,
        `work was queued against a connection that is ${label}`,
      );
    });
  }

  test("a disconnect after recovery stands the recovered job down", async () => {
    /**
     * Recovery must not become a way to import into a connection the customer
     * has removed. The job carries the generation that was current when it
     * was queued, and a disconnect bumps that generation, so the job finds a
     * row it no longer matches and exits without fetching or writing.
     *
     * What this does NOT exercise is the compare-and-set inside
     * `startIncremental` itself — the window between reading the row and
     * writing `syncState` is microseconds wide and there is no seam to
     * interleave a disconnect into it from a test. That CAS is belt and
     * braces over this, which is the guarantee that actually holds the line,
     * and this is the half that can be demonstrated rather than asserted.
     */
    await interrupted();
    const recovered = await schedule();
    assert.equal(recovered.recovered, 1);
    assert.equal(await queued(), 1, "recovery queued nothing to stand down");

    // The customer disconnects before the queued pass runs.
    await db.integration.update({
      where: { id: integrationId },
      data: { syncGeneration: 99, status: "disconnected", credentials: null },
    });

    const before = await db.emailMessage.count({ where: { integrationId } });
    const result = await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null, mode: "incremental", page: 0 },
        { transport: provider({ "/me/messages": graphMessages(["must-not-import"]) }) },
      ),
    );
    assert.equal(result.done, true, "the recovered job did not stand down");
    assert.equal(result.imported, 0, "a recovered job imported into a disconnected connection");
    assert.equal(
      await db.emailMessage.count({ where: { integrationId } }),
      before,
      "a recovered job wrote to a connection the customer had removed",
    );
  });

  test("Retry clears the bound; it does not relax who may be retried", async () => {
    const retry = () =>
      asOwner(() =>
        startIncremental({
          integrationId,
          workspaceId: tenant.workspaceId,
          ownerUserId: tenant.ownerId,
          manual: true,
        }),
      );

    // At the cap, which the scheduler will no longer touch.
    await interrupted("syncing", { recoveryAttempts: MAX_RECOVERY_ATTEMPTS });
    assert.equal((await schedule()).recovered, 0, "the scheduler should have given up by now");

    const manual = await retry();
    assert.equal(manual.queued, true, `Retry was refused: ${manual.reason}`);
    assert.equal(
      (await db.integration.findUniqueOrThrow({
        where: { id: integrationId }, select: { recoveryAttempts: true },
      })).recoveryAttempts,
      0,
      "Retry did not clear the recovery count",
    );

    // But it is the same eligibility gate. A disconnected connection is not
    // retryable just because a person asked.
    await db.domainEvent.deleteMany({ where: { name: "integration.sync", entityId: integrationId } });
    await db.integration.update({
      where: { id: integrationId },
      data: { status: "disconnected", syncState: "idle" },
    });
    const refused = await retry();
    assert.equal(refused.queued, false, "Retry started a sync on a disconnected connection");
    assert.equal(await queued(), 0);
    // Which gate refused, not merely that one did. Two independently enforce
    // this — the eligibility check and the `status: "connected"` clause in
    // the compare-and-set — and removing the first leaves the guarantee
    // intact but the reason wrong. Pinning the reason keeps both honest:
    // without this, deleting the eligibility check passes every assertion.
    assert.equal(
      refused.reason,
      "disconnected",
      "the eligibility gate did not refuse; something downstream did, by luck",
    );
  });
});
