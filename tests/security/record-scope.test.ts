import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { withTenantContext } from "../../src/lib/tenant-db";
import { isPostgres } from "../../src/lib/env";

/**
 * Record-level access: what a restricted member may read and write.
 *
 * The rule this file exists to prove, in one sentence: a restricted member
 * sees an Opportunity or a Project only when a grant names it, a child record
 * only when **every** anchor that child names is visible, and nothing that
 * names no anchor at all.
 *
 * The critical case is the one that looks like an edge case and is not: a task
 * on a granted opportunity that *also* names an ungranted project. Its
 * foreign key can be stripped from the response; its title cannot. "Rewrite
 * the Q3 pricing section for the Meridian bid" describes the ungranted work
 * whether or not an id travels with it. So the rule is ALL, and this suite
 * pins both directions of it.
 *
 * ACTOR    `db` — the application's client, connected as `tinycrm_app` with
 *          NOBYPASSRLS. Every read and write under test runs here.
 * OBSERVER `observer` — privileged, builds the world and reads ground truth.
 *          It never performs the operation under test.
 *
 * PostgreSQL only: SQLite has no policies, so there is no boundary to test.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;
let B: Tenant;

/** The world, by id. Anchors first: O and P are granted, U and Q are not. */
const id = {
  grantedOpp: "",
  ungrantedOpp: "",
  grantedProject: "",
  ungrantedProject: "",
  // Children, named for the anchors they carry.
  taskOnGrantedOpp: "",
  taskOnUngrantedOpp: "",
  taskOnGrantedProject: "",
  taskOnUngrantedProject: "",
  taskOnBothGranted: "",
  taskGrantedOppUngrantedProject: "",
  taskUngrantedOppGrantedProject: "",
  taskUnanchored: "",
  noteOnGrantedOpp: "",
  noteUnanchored: "",
  activityOnGrantedOpp: "",
  fileOnGrantedOpp: "",
  milestoneOnGrantedProject: "",
  milestoneOnUngrantedProject: "",
  emailOnGrantedProject: "",
  emailOnUngrantedProject: "",
  eventOnGrantedProject: "",
  dealOnGrantedProject: "",
  tagLinkOnGrantedOpp: "",
  tagLinkOnUngrantedOpp: "",
  fieldValueOnGrantedOpp: "",
  fieldValueOnUngrantedOpp: "",
  foreignOpportunity: "",
};

/** Reads as the restricted member, with the restriction declared the way the request path declares it. */
function asRestricted<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext(
    { workspaceIds: [A.workspaceId], userId: A.memberId, restrictedWorkspaceIds: [A.workspaceId] },
    fn,
  );
}

/** Reads as a full-workspace member of the same workspace. */
function asFullMember<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext({ workspaceIds: [A.workspaceId], userId: A.ownerId }, fn);
}

/** Whether the restricted member can see one row of a model, by exact id. */
async function visible(model: string, rowId: string): Promise<boolean> {
  const found = await asRestricted(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)[model].findFirst({ where: { id: rowId }, select: { id: true } }),
  );
  return found !== null;
}

before(async () => {
  A = await createTenant("ScopeA");
  B = await createTenant("ScopeB");

  const ws = A.workspaceId;
  const make = async () => {
    const opp = async (name: string) =>
      (await observer.opportunity.create({ data: { workspaceId: ws, name }, select: { id: true } })).id;
    const proj = async (name: string) =>
      (await observer.project.create({ data: { workspaceId: ws, name, lastActivityAt: new Date() }, select: { id: true } })).id;

    id.grantedOpp = await opp("Granted pursuit");
    id.ungrantedOpp = await opp("Somebody else's pursuit");
    id.grantedProject = await proj("Granted delivery");
    id.ungrantedProject = await proj("Somebody else's delivery");

    const task = async (name: string, opportunityId: string | null, projectId: string | null) =>
      (
        await observer.task.create({
          data: { workspaceId: ws, title: name, opportunityId, projectId },
          select: { id: true },
        })
      ).id;

    id.taskOnGrantedOpp = await task("On the granted opportunity", id.grantedOpp, null);
    id.taskOnUngrantedOpp = await task("On an opportunity they were not given", id.ungrantedOpp, null);
    id.taskOnGrantedProject = await task("On the granted project", null, id.grantedProject);
    id.taskOnUngrantedProject = await task("On a project they were not given", null, id.ungrantedProject);
    id.taskOnBothGranted = await task("On both, both granted", id.grantedOpp, id.grantedProject);
    id.taskGrantedOppUngrantedProject = await task(
      "Rewrite the pricing section for the other bid",
      id.grantedOpp,
      id.ungrantedProject,
    );
    id.taskUngrantedOppGrantedProject = await task("The mirror case", id.ungrantedOpp, id.grantedProject);
    id.taskUnanchored = await task("Attached to nothing at all", null, null);

    id.noteOnGrantedOpp = (
      await observer.note.create({
        data: { workspaceId: ws, title: "A note", plainText: "text", opportunityId: id.grantedOpp, updatedAt: new Date() },
        select: { id: true },
      })
    ).id;
    id.noteUnanchored = (
      await observer.note.create({
        data: { workspaceId: ws, title: "A floating note", plainText: "text", updatedAt: new Date() },
        select: { id: true },
      })
    ).id;
    id.activityOnGrantedOpp = (
      await observer.activity.create({
        data: { workspaceId: ws, type: "call", title: "A call", opportunityId: id.grantedOpp },
        select: { id: true },
      })
    ).id;
    id.fileOnGrantedOpp = (
      await observer.fileAsset.create({
        data: { workspaceId: ws, name: "proposal.pdf", storageKey: "probe/proposal.pdf", opportunityId: id.grantedOpp },
        select: { id: true },
      })
    ).id;

    id.milestoneOnGrantedProject = (
      await observer.milestone.create({
        data: { projectId: id.grantedProject, name: "Kickoff" },
        select: { id: true },
      })
    ).id;
    id.milestoneOnUngrantedProject = (
      await observer.milestone.create({
        data: { projectId: id.ungrantedProject, name: "Not theirs" },
        select: { id: true },
      })
    ).id;

    // These three carry a composite primary key and no id column, so they are
    // addressed by the pair that identifies them.
    await observer.opportunityContact.create({ data: { opportunityId: id.grantedOpp, contactId: A.contactId } });
    await observer.opportunityContact.create({ data: { opportunityId: id.ungrantedOpp, contactId: A.contactId } });
    await observer.projectContact.create({ data: { projectId: id.grantedProject, contactId: A.contactId } });

    id.emailOnGrantedProject = (
      await observer.emailMessage.create({
        data: {
          workspaceId: ws, threadId: "probe-thread-1", subject: "Theirs", snippet: "…",
          fromEmail: "them@example.invalid", sentAt: new Date(), direction: "inbound",
          projectId: id.grantedProject,
        },
        select: { id: true },
      })
    ).id;
    id.emailOnUngrantedProject = (
      await observer.emailMessage.create({
        data: {
          workspaceId: ws, threadId: "probe-thread-2", subject: "Not theirs", snippet: "…",
          fromEmail: "them@example.invalid", sentAt: new Date(), direction: "inbound",
          projectId: id.ungrantedProject,
        },
        select: { id: true },
      })
    ).id;
    id.eventOnGrantedProject = (
      await observer.calendarEvent.create({
        data: {
          workspaceId: ws,
          title: "Kickoff call",
          startAt: new Date(),
          endAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
          projectId: id.grantedProject,
        },
        select: { id: true },
      })
    ).id;

    // A deal on the granted project: never visible, per D1.
    id.dealOnGrantedProject = (
      await observer.deal.create({
        data: {
          workspaceId: ws, name: "Renewal", projectId: id.grantedProject,
          pipelineId: A.pipelineId, stageId: A.stageId, updatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

    id.tagLinkOnGrantedOpp = (
      await observer.tagLink.create({
        data: { workspaceId: ws, tagId: A.tagId, entityType: "opportunity", entityId: id.grantedOpp },
        select: { id: true },
      })
    ).id;
    id.tagLinkOnUngrantedOpp = (
      await observer.tagLink.create({
        data: { workspaceId: ws, tagId: A.tagId, entityType: "opportunity", entityId: id.ungrantedOpp },
        select: { id: true },
      })
    ).id;

    const field = await observer.customFieldDef.create({
      data: { workspaceId: ws, entityType: "opportunity", key: "scope_probe", label: "Probe", type: "text" },
      select: { id: true },
    });
    id.fieldValueOnGrantedOpp = (
      await observer.customFieldValue.create({
        data: {
          workspaceId: ws, fieldId: field.id, entityType: "opportunity",
          entityId: id.grantedOpp, value: "theirs", updatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
    id.fieldValueOnUngrantedOpp = (
      await observer.customFieldValue.create({
        data: {
          workspaceId: ws, fieldId: field.id, entityType: "opportunity",
          entityId: id.ungrantedOpp, value: "secret", updatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  };
  await make();

  // A neighbouring workspace, for the cross-tenant case.
  id.foreignOpportunity = (
    await observer.opportunity.create({
      data: { workspaceId: B.workspaceId, name: "Another tenant's pursuit" },
      select: { id: true },
    })
  ).id;

  // The member is restricted, and holds exactly two grants.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: ws, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  await observer.recordGrant.createMany({
    data: [
      { workspaceId: ws, userId: A.memberId, anchorType: "opportunity", anchorId: id.grantedOpp, grantedById: A.ownerId },
      { workspaceId: ws, userId: A.memberId, anchorType: "project", anchorId: id.grantedProject, grantedById: A.ownerId },
      // A grant in THIS workspace naming another workspace's opportunity. It
      // must unlock nothing: a grant is not a capability that travels.
      { workspaceId: ws, userId: A.memberId, anchorType: "opportunity", anchorId: id.foreignOpportunity, grantedById: A.ownerId },
    ],
  });
});

after(async () => {
  await cleanupTenants([A, B]);
  await observer.$disconnect();
});

describe("anchors are visible only when granted", () => {
  test("the granted opportunity and project are visible", pgOnly ?? {}, async () => {
    assert.equal(await visible("opportunity", id.grantedOpp), true, "a granted opportunity is invisible");
    assert.equal(await visible("project", id.grantedProject), true, "a granted project is invisible");
  });

  test("everything else in the same workspace is not", pgOnly ?? {}, async () => {
    assert.equal(await visible("opportunity", id.ungrantedOpp), false, "an ungranted opportunity is visible");
    assert.equal(await visible("project", id.ungrantedProject), false, "an ungranted project is visible");
  });

  test("listing shows only what was granted", pgOnly ?? {}, async () => {
    const opps = await asRestricted(() => db.opportunity.findMany({ select: { id: true } }));
    const projects = await asRestricted(() => db.project.findMany({ select: { id: true } }));
    assert.deepEqual(opps.map((o) => o.id), [id.grantedOpp], "the opportunity list is not the granted set");
    assert.deepEqual(projects.map((p) => p.id), [id.grantedProject], "the project list is not the granted set");
  });
});

describe("a child is visible only when every anchor it names is", () => {
  // The whole of S3A-1, case by case. The fifth and sixth are the ones that
  // decide whether the rule is ALL or ANY.
  const cases: [keyof typeof id, boolean, string][] = [
    ["taskOnGrantedOpp", true, "granted opportunity only"],
    ["taskOnGrantedProject", true, "granted project only"],
    ["taskOnBothGranted", true, "both anchors granted"],
    ["taskGrantedOppUngrantedProject", false, "granted opportunity + ungranted project"],
    ["taskUngrantedOppGrantedProject", false, "ungranted opportunity + granted project"],
    ["taskOnUngrantedOpp", false, "ungranted opportunity only"],
    ["taskOnUngrantedProject", false, "ungranted project only"],
    ["taskUnanchored", false, "no anchor at all"],
  ];

  for (const [key, expected, label] of cases) {
    test(`a task with ${label} is ${expected ? "visible" : "invisible"}`, pgOnly ?? {}, async () => {
      assert.equal(
        await visible("task", id[key]),
        expected,
        expected
          ? "work inside a granted anchor was hidden from the person doing it"
          : "a task disclosed work the member was never given",
      );
    });
  }

  test("the same rule holds for notes, activities and files", pgOnly ?? {}, async () => {
    assert.equal(await visible("note", id.noteOnGrantedOpp), true, "a note on granted work is hidden");
    assert.equal(await visible("note", id.noteUnanchored), false, "an unanchored note is visible");
    assert.equal(await visible("activity", id.activityOnGrantedOpp), true, "an activity on granted work is hidden");
    assert.equal(await visible("fileAsset", id.fileOnGrantedOpp), true, "a file on granted work is hidden");
  });

  test("milestones follow their project", pgOnly ?? {}, async () => {
    assert.equal(await visible("milestone", id.milestoneOnGrantedProject), true, "a milestone on granted work is hidden");
    assert.equal(await visible("milestone", id.milestoneOnUngrantedProject), false, "a milestone disclosed an ungranted project");
  });

  test("contact links follow their anchor", pgOnly ?? {}, async () => {
    const links = await asRestricted(() =>
      db.opportunityContact.findMany({ select: { opportunityId: true } }),
    );
    const projectLinks = await asRestricted(() =>
      db.projectContact.findMany({ select: { projectId: true } }),
    );
    assert.deepEqual(
      [...new Set(links.map((l) => l.opportunityId))],
      [id.grantedOpp],
      "the contact links a restricted member can read are not exactly those of their granted opportunity",
    );
    assert.deepEqual(
      [...new Set(projectLinks.map((l) => l.projectId))],
      [id.grantedProject],
      "the project contact links are not exactly those of the granted project",
    );
  });

  test("email and calendar reach only through a granted project", pgOnly ?? {}, async () => {
    assert.equal(await visible("emailMessage", id.emailOnGrantedProject), true, "correspondence on granted work is hidden");
    assert.equal(await visible("emailMessage", id.emailOnUngrantedProject), false, "correspondence on ungranted work is visible");
    assert.equal(await visible("calendarEvent", id.eventOnGrantedProject), true, "a meeting on granted work is hidden");
  });

  test("tags and custom field values follow their anchor", pgOnly ?? {}, async () => {
    assert.equal(await visible("tagLink", id.tagLinkOnGrantedOpp), true, "a tag on granted work is hidden");
    assert.equal(await visible("tagLink", id.tagLinkOnUngrantedOpp), false, "a tag disclosed an ungranted opportunity");
    assert.equal(await visible("customFieldValue", id.fieldValueOnGrantedOpp), true, "a field value on granted work is hidden");
    assert.equal(
      await visible("customFieldValue", id.fieldValueOnUngrantedOpp),
      false,
      "a custom field value disclosed data from an ungranted opportunity",
    );
  });
});

describe("deals are never visible to a restricted member", () => {
  test("not even one attached to a granted project", pgOnly ?? {}, async () => {
    assert.equal(await visible("deal", id.dealOnGrantedProject), false, "a deal reached a restricted member");
    const all = await asRestricted(() => db.deal.findMany({ select: { id: true } }));
    assert.deepEqual(all, [], "deals were listed to a restricted member");
  });
});

describe("a grant does not travel between workspaces", () => {
  test("a grant naming another tenant's record unlocks nothing", pgOnly ?? {}, async () => {
    const seen = await withTenantContext(
      { workspaceIds: [A.workspaceId], userId: A.memberId, restrictedWorkspaceIds: [A.workspaceId] },
      () => db.opportunity.findFirst({ where: { id: id.foreignOpportunity }, select: { id: true } }),
    );
    assert.equal(seen, null, "a grant in one workspace reached a record in another");
  });
});

describe("an id is not a key", () => {
  test("probing by exact id is indistinguishable from a record that does not exist", pgOnly ?? {}, async () => {
    const hidden = await asRestricted(() =>
      db.opportunity.findFirst({ where: { id: id.ungrantedOpp }, select: { id: true } }),
    );
    const invented = await asRestricted(() =>
      db.opportunity.findFirst({ where: { id: "cmdoesnotexist000000000000" }, select: { id: true } }),
    );
    assert.equal(hidden, null, "an ungranted record answered to its id");
    assert.equal(invented, null, "an invented id answered");
    assert.deepEqual(hidden, invented, "a hidden record and a missing one are distinguishable");
  });
});

describe("writes cannot reach past the grant", () => {
  test("a child cannot be created on an anchor the member cannot see", pgOnly ?? {}, async () => {
    await assert.rejects(
      () =>
        asRestricted(() =>
          db.task.create({
            data: { workspaceId: A.workspaceId, title: "Planted", opportunityId: id.ungrantedOpp },
          }),
        ),
      /row-level security/i,
      "a restricted member created work on an opportunity they cannot see",
    );
  });

  test("a child may be created inside an anchor the member can see", pgOnly ?? {}, async () => {
    const created = await asRestricted(() =>
      db.task.create({
        data: { workspaceId: A.workspaceId, title: "Their own next step", opportunityId: id.grantedOpp },
        select: { id: true },
      }),
    );
    assert.ok(created.id, "a restricted member cannot work inside the anchor they were given");
    await observer.task.delete({ where: { id: created.id } });
  });

  test("a visible child cannot be re-parented onto an invisible anchor", pgOnly ?? {}, async () => {
    const moved = await asRestricted(() =>
      db.task.updateMany({
        where: { id: id.taskOnGrantedOpp },
        data: { opportunityId: id.ungrantedOpp },
      }),
    ).catch((error: Error) => error);

    if (moved instanceof Error) {
      assert.match(moved.message, /row-level security/i, "the re-parent failed for the wrong reason");
    } else {
      assert.equal(moved.count, 0, "a restricted member re-parented a record onto an anchor they cannot see");
    }

    const after = await observer.task.findFirst({
      where: { id: id.taskOnGrantedOpp },
      select: { opportunityId: true },
    });
    assert.equal(after?.opportunityId, id.grantedOpp, "the record was moved anyway");
  });

  test("a visible child cannot be orphaned out of sight", pgOnly ?? {}, async () => {
    // Unanchored is invisible, so detaching is a write that would hide a row
    // from its own author — and, more to the point, a write whose result the
    // policy must still admit.
    const orphaned = await asRestricted(() =>
      db.task.updateMany({
        where: { id: id.taskOnGrantedOpp },
        data: { opportunityId: null, projectId: null },
      }),
    ).catch((error: Error) => error);

    if (orphaned instanceof Error) {
      assert.match(orphaned.message, /row-level security/i, "the detach failed for the wrong reason");
    } else {
      assert.equal(orphaned.count, 0, "a restricted member detached a record into invisibility");
    }
  });
});

describe("revocation takes effect immediately", () => {
  test("deleting the grant closes the door in the same session", pgOnly ?? {}, async () => {
    assert.equal(await visible("opportunity", id.grantedOpp), true, "the grant was not in effect to begin with");

    const grant = await observer.recordGrant.findFirst({
      where: { workspaceId: A.workspaceId, userId: A.memberId, anchorType: "opportunity", anchorId: id.grantedOpp },
      select: { id: true, workspaceId: true, userId: true, anchorType: true, anchorId: true, grantedById: true },
    });
    assert.ok(grant, "the grant is missing");
    await observer.recordGrant.delete({ where: { id: grant.id } });

    try {
      assert.equal(await visible("opportunity", id.grantedOpp), false, "a revoked grant still opened the record");
      assert.equal(await visible("task", id.taskOnGrantedOpp), false, "a revoked grant still opened its children");
    } finally {
      await observer.recordGrant.create({
        data: {
          workspaceId: grant.workspaceId,
          userId: grant.userId,
          anchorType: grant.anchorType,
          anchorId: grant.anchorId,
          grantedById: grant.grantedById,
        },
      });
    }
  });
});

describe("full-workspace members are untouched", () => {
  test("a full member still sees every record in the workspace", pgOnly ?? {}, async () => {
    const [opps, projects, tasks, deals] = await asFullMember(async () => [
      await db.opportunity.count(),
      await db.project.count(),
      await db.task.count(),
      await db.deal.count(),
    ]);
    assert.ok(opps >= 2, `a full member sees ${opps} opportunities`);
    assert.ok(projects >= 2, `a full member sees ${projects} projects`);
    assert.ok(tasks >= 8, `a full member sees ${tasks} tasks`);
    assert.ok(deals >= 1, "a full member lost sight of deals");
  });
});

describe("the AI boundary from S7 is unchanged", () => {
  test("person-scoped AI policies still say what they said", pgOnly ?? {}, async () => {
    const rows = await observer.$queryRaw<{ tablename: string; qual: string }[]>`
      SELECT tablename, qual FROM pg_policies
      WHERE tablename IN ('AiInsight', 'AiThread', 'AiMessage')
      ORDER BY tablename
    `;
    const byTable = new Map(rows.map((r) => [r.tablename, r.qual.replace(/\s+/g, " ")]));
    assert.match(byTable.get("AiInsight") ?? "", /kind = 'brief'/, "the brief policy changed");
    assert.match(byTable.get("AiInsight") ?? "", /app_user_id\(\)/, "the brief is no longer owner-scoped");
    assert.match(byTable.get("AiThread") ?? "", /app_user_id\(\)/, "threads are no longer person-scoped");
    assert.match(byTable.get("AiMessage") ?? "", /app_user_id\(\)/, "messages are no longer person-scoped");
  });
});
