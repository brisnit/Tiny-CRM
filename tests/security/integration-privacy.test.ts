import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db as observer, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { isPostgres } from "../../src/lib/env";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";

/**
 * A connection belongs to the person who made it, and imported mail is theirs.
 *
 * ACTOR    `db` — the application's client, connected as `tinycrm_app` with
 *          NOBYPASSRLS. Every attempt under test runs here, so a policy that
 *          does not exist shows up as a success rather than as a refusal.
 * OBSERVER `observer` — privileged, builds the world and reads ground truth. It
 *          never performs the operation under test, because a harness bound by
 *          the same policies cannot tell a refused read from an empty one.
 *
 * PostgreSQL only: SQLite has no policies, and a passing run there would be
 * vacuous. The application-level half of the same rule — which is what protects
 * SQLite and development — is covered in tests/unit/integration-visibility.test.ts.
 */
const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let host: Tenant;
let colleague = { userId: "", email: "" };
let outsider: Tenant;

before(async () => {
  host = await createTenant("MailboxOwner", { plan: "pro" });
  outsider = await createTenant("OtherCompany", { plan: "pro" });

  // A full-workspace teammate in the SAME workspace. This is the case the
  // policy exists for: workspace membership is not consent to read a
  // colleague's inbox.
  const user = await observer.user.create({
    data: {
      email: `colleague-${Date.now()}@privacy.test`,
      name: "Colleague",
      updatedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  colleague = { userId: user.id, email: user.email };
  await observer.workspaceMember.create({
    data: { workspaceId: host.workspaceId, userId: user.id, role: "admin" },
  });
});

after(async () => {
  await observer.emailMessage.deleteMany({ where: { workspaceId: host.workspaceId } });
  await observer.calendarEvent.deleteMany({ where: { workspaceId: host.workspaceId } });
  await observer.integration.deleteMany({ where: { workspaceId: host.workspaceId } });
  await observer.workspaceMember.deleteMany({ where: { userId: colleague.userId } });
  await observer.user.deleteMany({ where: { id: colleague.userId } });
  await cleanupTenants([host, outsider]);
  await observer.$disconnect();
});

/** Runs as a given user, with that user's workspace in context. */
function asUser<T>(userId: string, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return runAsTestIdentity(userId, () =>
    withTenantContext({ workspaceIds: [workspaceId], userId, restrictedWorkspaceIds: [] }, fn),
  );
}

describe("a mailbox connection is not readable by a teammate", () => {
  test("the owner sees their own connection; an admin colleague sees nothing", pgOnly, async () => {
    const created = await observer.integration.create({
      data: {
        workspaceId: host.workspaceId,
        userId: host.ownerId,
        provider: "outlook",
        status: "connected",
        accountEmail: "owner@host.test",
        // Whatever this column holds is encrypted, but the policy is what stops
        // it being read at all. Both layers, not either.
        credentials: "v1.integration-credentials.aaaa.bbbb.cccc",
      },
      select: { id: true },
    });

    const mine = await asUser(host.ownerId, host.workspaceId, () =>
      db.integration.findMany({ select: { id: true, accountEmail: true } }),
    );
    assert.deepEqual(mine.map((r) => r.id), [created.id], "the owner cannot see their own connection");

    const theirs = await asUser(colleague.userId, host.workspaceId, () =>
      db.integration.findMany({ select: { id: true, accountEmail: true, credentials: true } }),
    );
    assert.deepEqual(theirs, [], "a workspace admin read a colleague's mailbox connection");
  });

  test("a teammate cannot reach it by id either, and the id is not a hint", pgOnly, async () => {
    const row = await observer.integration.findFirstOrThrow({
      where: { workspaceId: host.workspaceId },
      select: { id: true },
    });
    const found = await asUser(colleague.userId, host.workspaceId, () =>
      db.integration.findUnique({ where: { id: row.id }, select: { id: true } }),
    );
    assert.equal(found, null, "a known connection id was readable by a teammate");
  });

  test("a teammate cannot create a connection in somebody else's name", pgOnly, async () => {
    let refused = false;
    try {
      await asUser(colleague.userId, host.workspaceId, () =>
        db.integration.create({
          data: {
            workspaceId: host.workspaceId,
            userId: host.ownerId, // not themselves
            provider: "gmail",
            status: "connected",
          },
        }),
      );
    } catch (error) {
      refused = true;
      assert.match(String(error), /row-level security|42501/i);
    }
    assert.ok(refused, "a teammate inserted a connection owned by someone else");
  });
});

describe("imported mail is private to its owner", () => {
  before(async () => {
    await observer.emailMessage.createMany({
      data: [
        {
          workspaceId: host.workspaceId, provider: "outlook", externalId: "priv-1",
          threadId: "t-priv", subject: "Private thread", snippet: "…",
          fromEmail: "client@example.test", sentAt: new Date(),
          source: "imported", ownerUserId: host.ownerId, visibility: "private",
        },
        {
          workspaceId: host.workspaceId, provider: "outlook", externalId: "shared-1",
          threadId: "t-shared", subject: "Shared thread", snippet: "…",
          fromEmail: "client@example.test", sentAt: new Date(),
          source: "imported", ownerUserId: host.ownerId, visibility: "workspace",
        },
        {
          workspaceId: host.workspaceId, provider: "mock", externalId: "seed-1",
          threadId: "t-seed", subject: "Seeded thread", snippet: "…",
          fromEmail: "demo@example.test", sentAt: new Date(),
          source: "seed", visibility: "workspace",
        },
      ],
    });
  });

  test("the owner sees their private thread", pgOnly, async () => {
    const subjects = await asUser(host.ownerId, host.workspaceId, () =>
      db.emailMessage.findMany({ select: { subject: true }, orderBy: { subject: "asc" } }),
    );
    assert.deepEqual(
      subjects.map((r) => r.subject),
      ["Private thread", "Seeded thread", "Shared thread"],
      "the owner cannot see their own imported mail",
    );
  });

  test("a teammate sees the shared and seeded threads, and not the private one", pgOnly, async () => {
    const subjects = await asUser(colleague.userId, host.workspaceId, () =>
      db.emailMessage.findMany({ select: { subject: true }, orderBy: { subject: "asc" } }),
    );
    assert.deepEqual(
      subjects.map((r) => r.subject),
      ["Seeded thread", "Shared thread"],
      "a teammate could read a private imported thread, or lost access to a shared one",
    );
  });

  test("a known id for a private thread is refused, not merely filtered from a list", pgOnly, async () => {
    const row = await observer.emailMessage.findFirstOrThrow({
      where: { externalId: "priv-1" }, select: { id: true },
    });
    const found = await asUser(colleague.userId, host.workspaceId, () =>
      db.emailMessage.findUnique({ where: { id: row.id }, select: { id: true } }),
    );
    assert.equal(found, null, "a private thread was readable by id");
  });

  test("a member of another workspace sees none of it", pgOnly, async () => {
    const rows = await asUser(outsider.ownerId, outsider.workspaceId, () =>
      db.emailMessage.findMany({ select: { id: true } }),
    );
    assert.deepEqual(rows, [], "tenant isolation leaked imported mail to another workspace");
  });

  test("the same rule applies to calendar events", pgOnly, async () => {
    await observer.calendarEvent.create({
      data: {
        workspaceId: host.workspaceId, provider: "google_calendar", externalId: "ev-priv",
        title: "Private meeting", startAt: new Date(), endAt: new Date(Date.now() + 3_600_000),
        source: "imported", ownerUserId: host.ownerId, visibility: "private",
      },
    });
    const mine = await asUser(host.ownerId, host.workspaceId, () =>
      db.calendarEvent.findMany({ where: { externalId: "ev-priv" }, select: { title: true } }),
    );
    assert.equal(mine.length, 1, "the owner cannot see their own imported event");
    const theirs = await asUser(colleague.userId, host.workspaceId, () =>
      db.calendarEvent.findMany({ where: { externalId: "ev-priv" }, select: { title: true } }),
    );
    assert.deepEqual(theirs, [], "a teammate read a private imported event");
  });
});

describe("de-duplication is scoped to the workspace, not to every customer", () => {
  test("two workspaces can import the same provider id", pgOnly, async () => {
    // The defect this replaces: `@@unique([provider, externalId])` was global,
    // so the second customer to sync a shared Google Calendar event — which
    // carries the same id in every invitee's calendar — hit 23505 and imported
    // nothing. Proven before the change with exactly this shape.
    const shared = { provider: "google_calendar", externalId: "SHARED-ACROSS-TENANTS" };
    await observer.calendarEvent.create({
      data: {
        workspaceId: host.workspaceId, ...shared, title: "Kickoff",
        startAt: new Date(), endAt: new Date(Date.now() + 3_600_000),
        source: "imported", ownerUserId: host.ownerId, visibility: "private",
      },
    });
    await observer.calendarEvent.create({
      data: {
        workspaceId: outsider.workspaceId, ...shared, title: "Kickoff",
        startAt: new Date(), endAt: new Date(Date.now() + 3_600_000),
        source: "imported", ownerUserId: outsider.ownerId, visibility: "private",
      },
    });
    const count = await observer.calendarEvent.count({ where: shared });
    assert.equal(count, 2, "two tenants could not both hold the same provider id");
  });

  test("two colleagues in ONE workspace can each import the same meeting", pgOnly, async () => {
    // The defect that workspace-scoping alone did not fix, and the reason the
    // key includes the owner. One Google Calendar event carries the same event
    // id in every invitee's calendar, so two connected teammates at one meeting
    // collided inside a single workspace:
    //
    //   colleague A imported the meeting
    //   colleague B REFUSED: 23505 on CalendarEvent_workspaceId_provider_externalId_key
    //
    // An upsert on that key would have been worse than a refusal: it would have
    // overwritten A's row and moved its ownership to B.
    const shared = { provider: "google_calendar", externalId: "ONE-MEETING-TWO-ATTENDEES" };
    const base = {
      ...shared,
      title: "Joint kickoff",
      startAt: new Date(),
      endAt: new Date(Date.now() + 3_600_000),
      source: "imported",
      visibility: "private",
      workspaceId: host.workspaceId,
    };
    await observer.calendarEvent.create({ data: { ...base, ownerUserId: host.ownerId } });
    await observer.calendarEvent.create({ data: { ...base, ownerUserId: colleague.userId } });

    const rows = await observer.calendarEvent.findMany({
      where: { workspaceId: host.workspaceId, ...shared },
      select: { ownerUserId: true },
      orderBy: { ownerUserId: "asc" },
    });
    assert.equal(rows.length, 2, "two colleagues could not both import one meeting");
    assert.deepEqual(
      new Set(rows.map((r) => r.ownerUserId)),
      new Set([host.ownerId, colleague.userId]),
      "ownership was mixed between the two copies",
    );

    // And each copy stays private to its own owner.
    const mine = await asUser(host.ownerId, host.workspaceId, () =>
      db.calendarEvent.findMany({ where: shared, select: { ownerUserId: true } }),
    );
    assert.deepEqual(
      mine.map((r) => r.ownerUserId),
      [host.ownerId],
      "one attendee could see the other attendee's copy",
    );
  });

  test("the same person re-syncing the same item still de-duplicates", pgOnly, async () => {
    // Per-owner must not mean per-call. A second sync pass over the same
    // mailbox has to collide, or every poll doubles the data.
    let refused = false;
    try {
      await observer.calendarEvent.create({
        data: {
          workspaceId: host.workspaceId,
          provider: "google_calendar",
          externalId: "ONE-MEETING-TWO-ATTENDEES",
          title: "Joint kickoff (again)",
          startAt: new Date(),
          endAt: new Date(Date.now() + 3_600_000),
          source: "imported",
          visibility: "private",
          ownerUserId: host.ownerId,
        },
      });
    } catch (error) {
      refused = true;
      assert.match(String(error), /unique|P2002/i);
    }
    assert.ok(refused, "the same owner imported the same event twice");
  });

  test("disconnecting keeps provenance and privacy, and does not delete anything", pgOnly, async () => {
    // What the customer is promised: the correspondence they have filed against
    // deals survives a disconnect. What must survive with it is the two things
    // that make it safe — `source`, so it stays excluded from AI, and
    // `visibility`/`ownerUserId`, so it stays theirs alone.
    const connection = await observer.integration.create({
      data: {
        workspaceId: host.workspaceId,
        userId: colleague.userId,
        provider: "outlook_calendar",
        status: "connected",
      },
      select: { id: true },
    });
    const row = await observer.emailMessage.create({
      data: {
        workspaceId: host.workspaceId,
        provider: "outlook",
        externalId: "survives-disconnect",
        threadId: "t-survive",
        subject: "Filed against a deal",
        snippet: "…",
        fromEmail: "client@example.test",
        sentAt: new Date(),
        integrationId: connection.id,
        source: "imported",
        ownerUserId: colleague.userId,
        visibility: "private",
      },
      select: { id: true },
    });

    // Disconnect, as the product will: remove the connection, keep the rows.
    // `onDelete: SetNull` is what makes that possible.
    await observer.integration.delete({ where: { id: connection.id } });

    const after = await observer.emailMessage.findUniqueOrThrow({
      where: { id: row.id },
      select: { integrationId: true, source: true, visibility: true, ownerUserId: true },
    });
    assert.equal(after.integrationId, null, "the connection link was not released");
    assert.equal(after.source, "imported", "provenance was lost, which would make this AI-eligible");
    assert.equal(after.visibility, "private", "a disconnected message became workspace-visible");
    assert.equal(after.ownerUserId, colleague.userId, "ownership was lost on disconnect");

    // Still invisible to the other colleague after the disconnect.
    const seen = await asUser(host.ownerId, host.workspaceId, () =>
      db.emailMessage.findMany({ where: { externalId: "survives-disconnect" }, select: { id: true } }),
    );
    assert.deepEqual(seen, [], "a disconnected private message became readable by a teammate");
  });

  test("but one owner still cannot hold it twice", pgOnly, async () => {
    let refused = false;
    try {
      await observer.calendarEvent.create({
        data: {
          workspaceId: host.workspaceId,
          provider: "google_calendar", externalId: "SHARED-ACROSS-TENANTS",
          title: "Kickoff again", startAt: new Date(), endAt: new Date(Date.now() + 3_600_000),
          source: "imported", ownerUserId: host.ownerId, visibility: "private",
        },
      });
    } catch (error) {
      refused = true;
      assert.match(String(error), /unique|P2002/i);
    }
    assert.ok(refused, "re-importing the same message twice created a duplicate");
  });
});
