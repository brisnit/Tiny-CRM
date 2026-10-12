import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { isPostgres } from "../../src/lib/env";
import { importPage, GenerationChangedError } from "../../src/lib/integrations/sync/import";
import { disconnectConnection } from "../../src/lib/integrations/connections";
import { withTenantContext } from "../../src/lib/tenant-db";
import type { GraphMessage } from "../../src/lib/integrations/sync/graph";

/**
 * A disconnect racing an in-flight page.
 *
 * ## Why a check at job start is not enough, and why one inside the
 * transaction is not enough either
 *
 * A sync job reads the generation, then spends seconds fetching a page over
 * the network. A disconnect in that window is invisible to a check that has
 * already happened — so the check has to happen again at write time.
 *
 * But a plain re-read inside the transaction still races. Under READ
 * COMMITTED, the read can see the old generation, the disconnect can commit,
 * and the writes then land for a connection that no longer exists. The page
 * write is therefore a compare-and-set that runs **first** and takes the row
 * lock, and a zero row count is the signal to abort.
 *
 * These tests are PostgreSQL-only on purpose. SQLite serialises writers, so a
 * run there cannot distinguish a correct implementation from one that merely
 * never interleaves — which is exactly the kind of green that means nothing.
 */
const pgOnly = isPostgres ? undefined : { skip: "needs real concurrency; SQLite serialises writers" };

let tenant: Tenant;
let integrationId = "";

function messages(count: number, prefix: string): GraphMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    conversationId: `thread-${prefix}`,
    subject: `Message ${prefix} ${i}`,
    bodyPreview: "…",
    receivedDateTime: new Date(Date.now() - i * 3_600_000).toISOString(),
    from: { emailAddress: { address: "client@example.test", name: "Client" } },
    toRecipients: [{ emailAddress: { address: "owner@canary.test" } }],
  }));
}

before(async () => {
  tenant = await createTenant("SyncRace", { plan: "pro" });
});

after(async () => {
  await db.emailMessage.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await cleanupTenants([tenant]);
  await db.$disconnect();
});

async function freshConnection(): Promise<string> {
  await db.emailMessage.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  const row = await db.integration.create({
    data: {
      workspaceId: tenant.workspaceId,
      userId: tenant.ownerId,
      provider: "outlook",
      status: "connected",
      accountEmail: "owner@canary.test",
      credentials: "v1.integration-credentials.a.b.c",
      syncGeneration: 1,
      syncState: "backfilling",
    },
    select: { id: true },
  });
  integrationId = row.id;
  return row.id;
}

const page = (msgs: GraphMessage[], generation: number, nextCursor: string | null) => ({
  integrationId,
  workspaceId: tenant.workspaceId,
  ownerUserId: tenant.ownerId,
  accountEmail: "owner@canary.test",
  generation,
  messages: msgs,
  nextCursor,
  visibleContactWhere: { workspaceId: tenant.workspaceId },
});

const inContext = <T>(fn: () => Promise<T>) =>
  withTenantContext(
    { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
    fn,
  );

describe("a page cannot land after the connection moved on", () => {
  test("a stale generation is refused and nothing is written", pgOnly, async () => {
    await freshConnection();
    await assert.rejects(
      () => inContext(() => importPage(page(messages(3, "stale"), 0, "cursor-2"))),
      GenerationChangedError,
      "a page from a previous generation was accepted",
    );
    assert.equal(
      await db.emailMessage.count({ where: { workspaceId: tenant.workspaceId } }),
      0,
      "messages were written despite the stale generation",
    );
  });

  test("a disconnect committed mid-flight rolls the whole page back", pgOnly, async () => {
    const id = await freshConnection();

    // The disconnect runs *while* the page transaction is open. The page's
    // compare-and-set has taken the row lock, so the disconnect blocks until
    // the page commits — and the page must then be the one that loses, because
    // its generation was read before the disconnect was requested.
    //
    // Interleaved deliberately: the import is started, then the disconnect is
    // fired without awaiting the import, then both are settled.
    const slowPage = inContext(() => importPage(page(messages(5, "inflight"), 1, "cursor-2")));
    const disconnect = inContext(() =>
      disconnectConnection({ integrationId: id, userId: tenant.ownerId, keepImported: true }),
    );

    const [pageResult, disconnectResult] = await Promise.allSettled([slowPage, disconnect]);
    assert.equal(disconnectResult.status, "fulfilled", "the disconnect did not complete");

    const after = await db.integration.findUniqueOrThrow({
      where: { id },
      select: { status: true, syncGeneration: true, credentials: true },
    });
    assert.equal(after.status, "disconnected");
    assert.equal(after.credentials, null, "a credential survived the disconnect");
    assert.ok(after.syncGeneration > 1, "the generation did not advance");

    // Whichever order the two landed in, the invariant is the same: no message
    // may exist for a connection whose generation has moved past the one the
    // page carried.
    const written = await db.emailMessage.count({
      where: { workspaceId: tenant.workspaceId, integrationId: id },
    });
    if (pageResult.status === "fulfilled") {
      // The page won the lock and committed first; the disconnect then bumped.
      // That is legitimate — the page was authorised when it wrote — and the
      // generation now prevents any *further* page.
      assert.equal(written, 5, "the page reported success but wrote nothing");
      await assert.rejects(
        () => inContext(() => importPage(page(messages(2, "after"), 1, "cursor-3"))),
        GenerationChangedError,
        "a second page was accepted after the disconnect",
      );
    } else {
      // The disconnect won; the page must have rolled back entirely.
      assert.ok(
        pageResult.reason instanceof GenerationChangedError,
        `expected GenerationChangedError, got ${String(pageResult.reason)}`,
      );
      assert.equal(written, 0, "a rolled-back page left messages behind");
    }
  });

  test("the cursor does not advance when the page is refused", pgOnly, async () => {
    const id = await freshConnection();
    await db.integration.update({ where: { id }, data: { syncCursor: "cursor-1" } });

    await assert.rejects(() => inContext(() => importPage(page(messages(2, "x"), 99, "cursor-99"))));

    const after = await db.integration.findUniqueOrThrow({
      where: { id },
      select: { syncCursor: true, pagesImported: true },
    });
    assert.equal(after.syncCursor, "cursor-1", "a refused page moved the cursor");
    assert.equal(after.pagesImported, 0, "a refused page counted against the cap");
  });

  test("messages and the cursor move together", pgOnly, async () => {
    const id = await freshConnection();
    const result = await inContext(() => importPage(page(messages(4, "together"), 1, "cursor-2")));
    assert.equal(result.imported, 4);

    const after = await db.integration.findUniqueOrThrow({
      where: { id },
      select: { syncCursor: true, pagesImported: true, lastSyncAt: true },
    });
    assert.equal(after.syncCursor, "cursor-2", "the cursor did not advance with the page");
    assert.equal(after.pagesImported, 1);
    assert.ok(after.lastSyncAt, "lastSyncAt was not set, so the UI would still say never");
    assert.equal(
      await db.emailMessage.count({ where: { integrationId: id } }),
      4,
      "the cursor advanced without the messages",
    );
  });

  test("re-running the same page imports nothing twice", pgOnly, async () => {
    await freshConnection();
    const first = await inContext(() => importPage(page(messages(3, "dup"), 1, "cursor-2")));
    assert.equal(first.imported, 3);
    assert.equal(first.duplicates, 0);

    // A retry after a crash replays the same page. It must be a no-op for the
    // rows and still advance the cursor.
    const second = await inContext(() => importPage(page(messages(3, "dup"), 1, "cursor-3")));
    assert.equal(second.imported, 0, "a replayed page imported duplicates");
    assert.equal(second.duplicates, 3);
    assert.equal(
      await db.emailMessage.count({ where: { workspaceId: tenant.workspaceId } }),
      3,
      "a replayed page duplicated the messages",
    );
  });
});
