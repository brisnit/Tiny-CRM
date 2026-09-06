import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Record lifecycle: create, edit, archive, restore, delete.
 *
 * The specific property under test is that **history outlives records**. The
 * schema uses `onDelete: SetNull` everywhere below the workspace, so deleting a
 * company detaches its timeline instead of erasing the account of what happened
 * with it. A cascade here would make an accidental delete unrecoverable and an
 * audit meaningless.
 */

let A: Tenant;

describe("record lifecycle", () => {
  before(async () => {
    A = await createTenant("Lifecycle");
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);
  const asMember = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.memberId, fn);

  test("archive hides a record from lists without destroying it", async () => {
    const { createContact, archiveContact, restoreContact } =
      await import("../../src/lib/actions/contacts");
    const { listContacts } = await import("../../src/lib/data/contacts");

    const created = await asMember(() =>
      createContact({ workspaceId: A.workspaceId, firstName: "Archive", lastName: "Probe" }),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const before = await listContacts([A.workspaceId], {});
    assert.ok(before.contacts.some((c) => c.id === created.data.id), "the new contact was not listed");

    const archived = await asMember(() => archiveContact(created.data.id));
    assert.equal(archived.ok, true, "a member could not archive");

    const during = await listContacts([A.workspaceId], {});
    assert.ok(
      !during.contacts.some((c) => c.id === created.data.id),
      "an archived contact still appears in the default list",
    );

    const row = await db.contact.findUnique({ where: { id: created.data.id } });
    assert.ok(row, "archiving deleted the row");
    assert.ok(row!.archivedAt, "archivedAt was not stamped");

    const restored = await asMember(() => restoreContact(created.data.id));
    assert.equal(restored.ok, true);

    const after = await listContacts([A.workspaceId], {});
    assert.ok(after.contacts.some((c) => c.id === created.data.id), "restore did not bring it back");
  });

  test("archiving does not count against the plan", async () => {
    // Otherwise "archive" would be a trap: users would hit their limit and have
    // no way to recover short of permanent deletion.
    const { getPlanUsage } = await import("../../src/lib/entitlements");
    const { requireActor } = await import("../../src/lib/auth/access");
    const { createContact, archiveContact } = await import("../../src/lib/actions/contacts");

    const usageOf = () => asOwner(async () => getPlanUsage(await requireActor()));

    const before = (await usageOf()).contacts;
    const created = await asOwner(() =>
      createContact({ workspaceId: A.workspaceId, firstName: "Quota", lastName: "Probe" }),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.equal((await usageOf()).contacts, before + 1, "a new contact did not count");
    await asOwner(() => archiveContact(created.data.id));
    assert.equal((await usageOf()).contacts, before, "an archived contact still counts against the plan");
  });

  test("permanent deletion detaches history rather than cascading it away", async () => {
    const { createCompany, deleteCompany } = await import("../../src/lib/actions/companies");

    const created = await asOwner(() =>
      createCompany({ workspaceId: A.workspaceId, name: "Detach Corp" }),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const companyId = created.data.id;

    const [activity, task, note, contact] = await Promise.all([
      db.activity.create({
        data: {
          workspaceId: A.workspaceId, type: "call", title: "the call that mattered",
          companyId, actorId: A.ownerId,
        },
      }),
      db.task.create({
        data: { workspaceId: A.workspaceId, title: "attached task", companyId, ownerId: A.ownerId },
      }),
      db.note.create({
        data: {
          workspaceId: A.workspaceId, title: "attached note", body: "<p>x</p>",
          plainText: "x", companyId, authorId: A.ownerId,
        },
      }),
      db.contact.create({
        data: {
          workspaceId: A.workspaceId, firstName: "Attached", lastName: "Person",
          fullName: "Attached Person", companyId, ownerId: A.ownerId,
        },
      }),
    ]);

    const deleted = await asOwner(() => deleteCompany(companyId, "Detach Corp"));
    assert.equal(deleted.ok, true, "the delete was refused");

    for (const [label, row] of [
      ["activity", await db.activity.findUnique({ where: { id: activity.id } })],
      ["task", await db.task.findUnique({ where: { id: task.id } })],
      ["note", await db.note.findUnique({ where: { id: note.id } })],
      ["contact", await db.contact.findUnique({ where: { id: contact.id } })],
    ] as const) {
      assert.ok(row, `deleting a company destroyed its ${label}`);
      assert.equal(
        (row as { companyId: string | null }).companyId,
        null,
        `the ${label} was not detached`,
      );
    }
  });

  test("deleting the workspace is the only cascade, and it is complete", async () => {
    // The workspace is the tenancy root. Deleting it must leave nothing behind,
    // or a "delete my data" request would be a lie.
    const B = await createTenant("Cascade");

    const before = await db.contact.count({ where: { workspaceId: B.workspaceId } });
    assert.ok(before > 0);

    const { deleteWorkspace } = await import("../../src/lib/actions/settings");
    const result = await runAsTestIdentity(B.ownerId, () =>
      deleteWorkspace(B.workspaceId, "Cascade Workspace"),
    );
    assert.equal(result.ok, true, "the workspace owner could not delete their workspace");

    for (const [label, count] of [
      ["contacts", await db.contact.count({ where: { workspaceId: B.workspaceId } })],
      ["companies", await db.company.count({ where: { workspaceId: B.workspaceId } })],
      ["deals", await db.deal.count({ where: { workspaceId: B.workspaceId } })],
      ["projects", await db.project.count({ where: { workspaceId: B.workspaceId } })],
      ["tasks", await db.task.count({ where: { workspaceId: B.workspaceId } })],
      ["notes", await db.note.count({ where: { workspaceId: B.workspaceId } })],
      ["activities", await db.activity.count({ where: { workspaceId: B.workspaceId } })],
      ["memberships", await db.workspaceMember.count({ where: { workspaceId: B.workspaceId } })],
    ] as const) {
      assert.equal(count, 0, `${label} survived the workspace deletion`);
    }

    // The audit trail deliberately outlives the workspace: it records that the
    // deletion happened, which is the one thing that must not be deletable by
    // the act of deleting.
    const entry = await db.auditLog.findFirst({
      where: { action: "workspace.deleted", entityId: B.workspaceId },
    });
    assert.ok(entry, "a workspace deletion left no audit trail");

    await db.user.deleteMany({ where: { id: { in: [B.ownerId, B.memberId, B.viewerId] } } });
  });

  test("a note converted to a task keeps every relationship the note carried", async () => {
    const { createNote, convertNoteToTask } = await import("../../src/lib/actions/notes");

    const created = await asMember(() =>
      createNote({
        workspaceId: A.workspaceId,
        title: "Convert me",
        body: "<p>Call them back about the renewal</p>",
        contactId: A.contactId,
        companyId: A.companyId,
        dealId: A.dealId,
      }),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const converted = await asMember(() => convertNoteToTask(created.data.id));
    assert.equal(converted.ok, true);
    if (!converted.ok) return;

    const task = await db.task.findUniqueOrThrow({ where: { id: converted.data.id } });
    assert.equal(task.contactId, A.contactId, "the contact link was lost");
    assert.equal(task.companyId, A.companyId, "the company link was lost");
    assert.equal(task.dealId, A.dealId, "the deal link was lost");
    assert.equal(task.workspaceId, A.workspaceId);

    const note = await db.note.findUnique({ where: { id: created.data.id } });
    assert.ok(note, "converting a note destroyed it");
  });

  test("a recurring task respawns exactly once when completed", async () => {
    const { toggleTask } = await import("../../src/lib/actions/tasks");

    const task = await db.task.create({
      data: {
        workspaceId: A.workspaceId,
        title: "Weekly check-in",
        ownerId: A.ownerId,
        recurrence: "weekly",
        dueAt: new Date("2026-03-02T17:00:00Z"),
      },
    });

    const before = await db.task.count({ where: { workspaceId: A.workspaceId, title: "Weekly check-in" } });
    const done = await asMember(() => toggleTask(task.id));
    assert.equal(done.ok, true);

    const after = await db.task.count({ where: { workspaceId: A.workspaceId, title: "Weekly check-in" } });
    assert.equal(after, before + 1, "the recurrence did not respawn exactly one task");

    const next = await db.task.findFirstOrThrow({
      where: { workspaceId: A.workspaceId, title: "Weekly check-in", status: "open" },
      orderBy: { createdAt: "desc" },
    });
    // Asserted in local calendar terms, not by adding 7 * 86_400_000 ms. A
    // weekly 9am task must stay at 9am across a daylight-saving boundary, and
    // 2026-03-08 is exactly such a boundary in US timezones.
    const previous = task.dueAt!;
    const next7 = next.dueAt!;
    assert.equal(next7.getHours(), previous.getHours(), "the local time of day drifted");
    assert.equal(next7.getMinutes(), previous.getMinutes());
    assert.equal(
      Math.round((next7.getTime() - previous.getTime()) / 3_600_000 / 24),
      7,
      "the next occurrence is not one week later",
    );

    // Un-completing must not spawn another.
    await asMember(() => toggleTask(task.id));
    const afterUndo = await db.task.count({
      where: { workspaceId: A.workspaceId, title: "Weekly check-in" },
    });
    assert.equal(afterUndo, after, "toggling back spawned another occurrence");
  });

  test("a failed multi-step write leaves nothing behind", async () => {
    // applyProposals writes several records plus a note in one transaction. A
    // foreign id in the batch must abort the whole thing, not leave orphans.
    const B = await createTenant("Partial");
    try {
      const { applyProposals } = await import("../../src/lib/actions/ai");
      const before = await db.company.count({ where: { workspaceId: A.workspaceId } });

      const result = await asOwner(() =>
        applyProposals(
          A.workspaceId,
          [
            {
              id: "p0", kind: "company", label: "Create Legit Co", isNew: true,
              payload: { name: "Legit Co" },
            },
            {
              id: "p1", kind: "contact", label: "Link a foreign contact",
              matchId: B.contactId, isNew: false, payload: {},
            },
          ],
          "probe",
        ),
      );

      assert.equal(result.ok, false, "a batch containing a foreign id was applied");
      const after = await db.company.count({ where: { workspaceId: A.workspaceId } });
      assert.equal(after, before, "the legitimate half of a failed batch was committed");
    } finally {
      await cleanupTenants([B]);
    }
  });
});
