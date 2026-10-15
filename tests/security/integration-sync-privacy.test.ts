import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db as observer, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { isPostgres } from "../../src/lib/env";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { getContact } from "../../src/lib/data/contacts";
import { importPage } from "../../src/lib/integrations/sync/import";
import type { GraphMessage } from "../../src/lib/integrations/sync/graph";

/**
 * A linked private message must leave no trace on a shared contact.
 *
 * Auto-linking is the feature that makes this hard. The contact is
 * workspace-visible; the message attached to it is not. Every surface that
 * reads from a contact therefore has to respect the message's own visibility,
 * and "every surface" is the part that rots — a count added for a badge, a
 * "recent activity" panel, a notification, each of them a plausible change
 * that silently discloses that a colleague is corresponding with someone.
 *
 * ACTOR    `db` — the application's client as `tinycrm_app`, NOBYPASSRLS.
 * OBSERVER `observer` — privileged, builds the world and reads ground truth.
 *
 * PostgreSQL only: on SQLite there are no policies, so the database half of
 * the guarantee cannot be observed and a pass would be vacuous.
 */
const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let host: Tenant;
let colleague = { userId: "", email: "" };
let contactId = "";
const SECRET_SUBJECT = "Acquisition terms — confidential";
const SECRET_SNIPPET = "the number we discussed";

before(async () => {
  host = await createTenant("SyncPrivacy", { plan: "pro" });

  const user = await observer.user.create({
    data: {
      email: `colleague-${Date.now()}@syncprivacy.test`,
      name: "Colleague",
      updatedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  colleague = { userId: user.id, email: user.email };
  await observer.workspaceMember.create({
    data: { workspaceId: host.workspaceId, userId: user.id, role: "admin" },
  });

  // A contact the whole workspace shares — this is the surface under test.
  const contact = await observer.contact.create({
    data: {
      workspaceId: host.workspaceId,
      firstName: "Shared",
      lastName: "Counterparty",
      fullName: "Shared Counterparty",
      email: "counterparty@example.test",
    },
    select: { id: true },
  });
  contactId = contact.id;

  const integration = await observer.integration.create({
    data: {
      workspaceId: host.workspaceId,
      userId: host.ownerId,
      provider: "outlook",
      status: "connected",
      accountEmail: "owner@canary.test",
      credentials: "v1.integration-credentials.a.b.c",
      syncGeneration: 1,
    },
    select: { id: true },
  });

  const message: GraphMessage = {
    id: "private-linked-1",
    conversationId: "thread-private",
    subject: SECRET_SUBJECT,
    bodyPreview: SECRET_SNIPPET,
    receivedDateTime: new Date().toISOString(),
    from: { emailAddress: { address: "counterparty@example.test", name: "Counterparty" } },
    toRecipients: [{ emailAddress: { address: "owner@canary.test" } }],
  };

  // Imported as the owner, exactly as the worker will.
  await runAsTestIdentity(host.ownerId, () =>
    withTenantContext(
      { workspaceIds: [host.workspaceId], userId: host.ownerId, restrictedWorkspaceIds: [] },
      () =>
        importPage({
          integrationId: integration.id,
          workspaceId: host.workspaceId,
          ownerUserId: host.ownerId,
          accountEmail: "owner@canary.test",
          generation: 1,
          messages: [message],
          nextCursor: null,
          visibleContactWhere: { workspaceId: host.workspaceId },
        }),
    ),
  );
});

after(async () => {
  await observer.emailMessage.deleteMany({ where: { workspaceId: host.workspaceId } });
  await observer.integration.deleteMany({ where: { workspaceId: host.workspaceId } });
  await observer.contact.deleteMany({ where: { workspaceId: host.workspaceId } });
  await observer.workspaceMember.deleteMany({ where: { userId: colleague.userId } });
  await observer.user.deleteMany({ where: { id: colleague.userId } });
  await cleanupTenants([host]);
  await observer.$disconnect();
});

function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runAsTestIdentity(userId, () =>
    withTenantContext(
      { workspaceIds: [host.workspaceId], userId, restrictedWorkspaceIds: [] },
      fn,
    ),
  );
}

const scope = (userId: string) => ({
  workspaceIds: [host.workspaceId],
  userId,
  restrictedWorkspaceIds: [] as string[],
});

describe("the message was linked, and is still private", () => {
  test("it was auto-linked to the contact it exactly matches", pgOnly, async () => {
    const row = await observer.emailMessage.findFirstOrThrow({
      where: { externalId: "private-linked-1" },
      select: { contactId: true, visibility: true, ownerUserId: true, source: true },
    });
    assert.equal(row.contactId, contactId, "an exact, unique, accessible match was not linked");
    assert.equal(row.visibility, "private", "auto-linking made it workspace-visible");
    assert.equal(row.ownerUserId, host.ownerId);
    assert.equal(row.source, "imported");
  });

  test("the owner sees it on the contact page", pgOnly, async () => {
    const contact = await asUser(host.ownerId, () => getContact(scope(host.ownerId), contactId));
    const subjects = (contact?.emails ?? []).map((e) => e.subject);
    assert.ok(
      subjects.includes(SECRET_SUBJECT),
      "the owner cannot see their own imported mail on the contact it is linked to",
    );
  });
});

describe("a colleague sees no trace of it on the shared contact", () => {
  test("the contact page shows no subject and no snippet", pgOnly, async () => {
    const contact = await asUser(colleague.userId, () =>
      getContact(scope(colleague.userId), contactId),
    );
    assert.ok(contact, "the colleague cannot see the shared contact at all, which is a different bug");

    const rendered = JSON.stringify(contact);
    assert.ok(!rendered.includes(SECRET_SUBJECT), "a private subject reached a colleague's contact page");
    assert.ok(!rendered.includes(SECRET_SNIPPET), "a private snippet reached a colleague's contact page");
    assert.deepEqual(contact!.emails ?? [], [], "a private message appeared in a colleague's list");
  });

  test("no count betrays it either", pgOnly, async () => {
    // A count is the subtlest disclosure: it says "this person is corresponding
    // with this contact" without quoting anything, and it is exactly what gets
    // added later for a badge.
    const visible = await asUser(colleague.userId, () =>
      db.emailMessage.count({ where: { contactId } }),
    );
    assert.equal(visible, 0, "a colleague could count a private message");

    const owner = await asUser(host.ownerId, () => db.emailMessage.count({ where: { contactId } }));
    assert.equal(owner, 1, "the owner's own count is wrong, so the policy is too strict");
  });

  test("it cannot be reached by id, by thread, or by filtering on the contact", pgOnly, async () => {
    const row = await observer.emailMessage.findFirstOrThrow({
      where: { externalId: "private-linked-1" },
      select: { id: true, threadId: true },
    });
    await asUser(colleague.userId, async () => {
      assert.equal(
        await db.emailMessage.findUnique({ where: { id: row.id }, select: { id: true } }),
        null,
        "a known id reached a private message",
      );
      assert.deepEqual(
        await db.emailMessage.findMany({ where: { threadId: row.threadId }, select: { id: true } }),
        [],
        "a thread id reached a private message",
      );
      assert.deepEqual(
        await db.emailMessage.findMany({ where: { contactId }, select: { id: true } }),
        [],
        "filtering by the shared contact reached a private message",
      );
    });
  });

  test("no activity or notification was created for it", pgOnly, async () => {
    // Nothing in the import writes either, and this is the test that keeps it
    // that way: an Activity row is workspace-visible by design, so a single
    // convenience line in the importer would leak the fact of correspondence
    // even while the message itself stayed private.
    const activities = await observer.activity.count({
      where: { workspaceId: host.workspaceId, contactId },
    });
    assert.equal(activities, 0, "the import created a workspace-visible activity row");

    const notifications = await observer.notification.count({
      where: { userId: colleague.userId },
    });
    assert.equal(notifications, 0, "the import notified someone who may not see the message");
  });

  test("the aggregate a dashboard would use does not include it", pgOnly, async () => {
    // groupBy is how a "most active contacts" panel gets written, and it is a
    // different query path from findMany — worth its own assertion rather than
    // assuming the policy covers every shape.
    const grouped = await asUser(colleague.userId, () =>
      db.emailMessage.groupBy({ by: ["contactId"], _count: { _all: true } }),
    );
    const forContact = grouped.find((g) => g.contactId === contactId);
    assert.equal(forContact, undefined, "an aggregate disclosed a private message to a colleague");
  });
});

describe("the application layer hides it too, which is all SQLite has", () => {
  /**
   * Not PostgreSQL-only, and that is the point.
   *
   * Mutation testing showed that removing the `visibleToUser` filter from the
   * contact loader failed nothing: row-level security caught it, so every
   * assertion above still passed. That is correct defence in depth on
   * PostgreSQL and worthless everywhere else — SQLite has no policies, so in
   * development and in the fast suite the application filter is the only thing
   * standing between a colleague and somebody's correspondence.
   *
   * So this runs on both engines. On PostgreSQL it is redundant with the
   * policy; on SQLite it is the whole guarantee.
   */
  test("getContact excludes a private message owned by someone else", async () => {
    const contact = await asUser(colleague.userId, () =>
      getContact(scope(colleague.userId), contactId),
    );
    assert.ok(contact, "the shared contact was not readable at all");
    assert.deepEqual(
      (contact!.emails ?? []).map((e) => e.subject),
      [],
      "the contact loader returned a private message to a colleague",
    );
  });

  test("and still returns the owner's own", async () => {
    // The control: a filter that hides everything would pass the test above.
    const contact = await asUser(host.ownerId, () => getContact(scope(host.ownerId), contactId));
    assert.deepEqual(
      (contact!.emails ?? []).map((e) => e.subject),
      [SECRET_SUBJECT],
      "the filter also hid the owner's own message",
    );
  });
});
