import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { candidateAddresses } from "../../src/lib/integrations/sync/associate";
import { importPage } from "../../src/lib/integrations/sync/import";
import { MAX_BACKFILL_PAGES, BACKFILL_WINDOW_DAYS, backfillStartUrl } from "../../src/lib/integrations/sync/graph";
import type { GraphMessage } from "../../src/lib/integrations/sync/graph";

/**
 * Which contact a message is filed against, and what happens at the cap.
 *
 * Auto-linking is allowed to be wrong in only one direction: it may decline to
 * link. Filing correspondence against the wrong person is visible on a shared
 * record and is not recoverable by the person who notices it.
 */
let tenant: Tenant;
let integrationId = "";

before(async () => {
  tenant = await createTenant("SyncAssoc", { plan: "pro" });
  const row = await db.integration.create({
    data: {
      workspaceId: tenant.workspaceId,
      userId: tenant.ownerId,
      provider: "outlook",
      status: "connected",
      accountEmail: "me@canary.test",
      credentials: "v1.integration-credentials.a.b.c",
      syncGeneration: 1,
    },
    select: { id: true },
  });
  integrationId = row.id;
});

after(async () => {
  await db.emailMessage.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.contact.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await cleanupTenants([tenant]);
  await db.$disconnect();
});

async function contact(email: string, name: string) {
  return db.contact.create({
    data: {
      workspaceId: tenant.workspaceId,
      firstName: name,
      lastName: "Person",
      fullName: `${name} Person`,
      email,
    },
    select: { id: true },
  });
}

function message(id: string, from: string, to: string[] = ["me@canary.test"]): GraphMessage {
  return {
    id,
    conversationId: `t-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: "…",
    receivedDateTime: new Date().toISOString(),
    from: { emailAddress: { address: from } },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  };
}

const run = (messages: GraphMessage[], nextCursor: string | null = null) =>
  runAsTestIdentity(tenant.ownerId, () =>
    withTenantContext(
      { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
      () =>
        importPage({
          integrationId,
          workspaceId: tenant.workspaceId,
          ownerUserId: tenant.ownerId,
          accountEmail: "me@canary.test",
          generation: 1,
          messages,
          nextCursor,
          visibleContactWhere: { workspaceId: tenant.workspaceId },
        }),
    ),
  );

describe("auto-linking only on an exact, unique, accessible match", () => {
  test("an exact unique match is linked", async () => {
    const c = await contact("alice@client.test", "Alice");
    const result = await run([message("m-exact", "alice@client.test")]);
    assert.equal(result.linked, 1);
    const row = await db.emailMessage.findFirstOrThrow({
      where: { externalId: "m-exact" }, select: { contactId: true },
    });
    assert.equal(row.contactId, c.id);
  });

  test("two contacts sharing an address link to neither", async () => {
    await contact("shared@client.test", "First");
    await contact("shared@client.test", "Second");
    const result = await run([message("m-ambiguous", "shared@client.test")]);
    assert.equal(result.linked, 0, "an ambiguous address was linked anyway");
    assert.equal(result.unlinked.ambiguous, 1);
    const row = await db.emailMessage.findFirstOrThrow({
      where: { externalId: "m-ambiguous" }, select: { contactId: true },
    });
    assert.equal(row.contactId, null, "a coin toss was recorded as a fact");
  });

  test("a near miss is not a match", async () => {
    await contact("bob@client.test", "Bob");
    // Same domain, same local part with a suffix, and a display-name match —
    // each of which a fuzzy matcher would accept.
    const result = await run([
      message("m-suffix", "bob+newsletter@client.test"),
      message("m-domain", "someone-else@client.test"),
    ]);
    assert.equal(result.linked, 0, "a near miss was treated as an exact match");
    assert.equal(result.unlinked["no-match"], 2);
  });

  test("the account's own address is never the counterparty", async () => {
    await contact("me@canary.test", "Myself");
    // A message from me to a stranger must not file against my own contact
    // record just because my address appears on it.
    const result = await run([message("m-self", "me@canary.test", ["stranger@elsewhere.test"])]);
    assert.equal(result.linked, 0, "a message was filed against the connected account itself");
  });

  test("a contact the person cannot see is not linked, and says so", async () => {
    const hidden = await contact("hidden@client.test", "Hidden");
    const result = await runAsTestIdentity(tenant.ownerId, () =>
      withTenantContext(
        { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
        () =>
          importPage({
            integrationId,
            workspaceId: tenant.workspaceId,
            ownerUserId: tenant.ownerId,
            accountEmail: "me@canary.test",
            generation: 1,
            messages: [message("m-hidden", "hidden@client.test")],
            nextCursor: null,
            // A narrower scope, as a restricted member would read contacts
            // through: the contact exists but is outside what they may see.
            visibleContactWhere: { workspaceId: tenant.workspaceId, id: { not: hidden.id } },
          }),
      ),
    );
    assert.equal(result.linked, 0, "a message was linked to a contact its owner cannot see");
    assert.equal(
      result.unlinked["not-accessible"],
      1,
      "the reason was not distinguished from an ordinary no-match",
    );
  });

  test("the recipient is used when the sender is us", async () => {
    const c = await contact("carol@client.test", "Carol");
    const result = await run([message("m-outbound", "me@canary.test", ["carol@client.test"])]);
    assert.equal(result.linked, 1);
    const row = await db.emailMessage.findFirstOrThrow({
      where: { externalId: "m-outbound" }, select: { contactId: true },
    });
    assert.equal(row.contactId, c.id);
  });

  test("candidateAddresses drops our own address and malformed ones", () => {
    assert.deepEqual(
      candidateAddresses({
        from: "ME@Canary.test",
        to: ["x@y.test", "not-an-address", "", null, "X@Y.test"],
        accountEmail: "me@canary.test",
      }),
      ["x@y.test"],
      "own address, duplicates, or malformed values survived",
    );
  });
});

describe("the backfill is bounded, and says so when it stops short", () => {
  test("the window is 30 days and the start URL asks for exactly that", () => {
    assert.equal(BACKFILL_WINDOW_DAYS, 30);
    const url = new URL(backfillStartUrl());
    const filter = url.searchParams.get("$filter") ?? "";
    assert.match(filter, /receivedDateTime ge /, "the start URL does not bound the window");
    const since = new Date(filter.replace("receivedDateTime ge ", ""));
    const days = (Date.now() - since.getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.01, `the window is ${days.toFixed(2)} days, not 30`);
    assert.equal(url.searchParams.get("$top"), "50", "the page size is unbounded");
    // Only the fields used — not the full body.
    assert.doesNotMatch(url.searchParams.get("$select") ?? "", /(^|,)body(,|$)/);
  });

  test("reaching the cap marks the import incomplete rather than finished", async () => {
    await db.integration.update({
      where: { id: integrationId },
      // One page short of the cap, so the next page hits it.
      data: { pagesImported: MAX_BACKFILL_PAGES - 1, backfillTruncated: false },
    });

    // A page that still has a next cursor: there IS more, and we are stopping.
    const result = await run([message("m-cap", "capped@client.test")], "cursor-there-is-more");
    assert.equal(result.truncated, true, "the cap was reached but the import did not say so");

    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { backfillTruncated: true, backfillCompletedAt: true, syncCursor: true, importedThrough: true },
    });
    assert.equal(after.backfillTruncated, true, "the incomplete import is not flagged");
    assert.ok(after.backfillCompletedAt, "the backfill did not stop");
    assert.equal(
      after.syncCursor,
      "cursor-there-is-more",
      "the cursor was discarded, so resuming would have to start over",
    );
    assert.ok(after.importedThrough, "how far back the import reached was not recorded");
  });

  test("a backfill that finishes naturally is not marked incomplete", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: { pagesImported: 0, backfillTruncated: false, backfillCompletedAt: null },
    });
    const result = await run([message("m-last", "last@client.test")], null);
    assert.equal(result.truncated, false);
    const after = await db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { backfillTruncated: true, backfillCompletedAt: true, syncCursor: true },
    });
    assert.equal(after.backfillTruncated, false, "a complete import was flagged incomplete");
    assert.ok(after.backfillCompletedAt, "a finished backfill was not marked finished");
    assert.equal(after.syncCursor, null, "a finished backfill kept a cursor");
  });
});
