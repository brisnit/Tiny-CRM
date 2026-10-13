import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { encryptSecret } from "../../src/lib/crypto";
import { RetryAfterError } from "../../src/lib/jobs";
import { MAX_BACKFILL_PAGES } from "../../src/lib/integrations/sync/graph";
import { runSyncPage, startBackfill, resumeBackfill } from "../../src/lib/integrations/sync/worker";
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
