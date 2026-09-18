import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { isPostgres } from "../../src/lib/env";

/**
 * Restriction has to reach the database, or the policies are decoration.
 *
 * Step 3A put record-level rules in PostgreSQL and proved them by opening a
 * tenant context by hand, with the restriction declared. The application does
 * not open its contexts that way. Server actions build
 * `{ workspaceIds, userId }` and say nothing about scope, so
 * `app.restricted_workspace_ids` arrives empty, `app_is_restricted_in()`
 * answers false, and every policy written in 010 falls through to the
 * unrestricted branch.
 *
 * The effect is narrow and total: a restricted member is scoped on page reads,
 * which pass a full ReadScope, and unscoped through every server action —
 * create, update, archive, delete — and through requireRecordAccess, the guard
 * that exists to stop exactly this.
 *
 * So this file drives the real actions. `createTask`, not `db.task.create`.
 * The earlier suite proved the policy; this one proves the plumbing, and the
 * difference between those two is the defect.
 *
 * PostgreSQL only: the policies being bypassed exist only there.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;

/** An opportunity the restricted member was never granted. */
let invisibleOpportunity = "";
/** A task hanging off it — invisible for the same reason. */
let invisibleTask = "";
/** The opportunity they hold, and a task inside it. */
let grantedOpportunity = "";
let visibleTask = "";

before(async () => {
  A = await createTenant("PlumbA");

  const opp = async (name: string) =>
    (await observer.opportunity.create({ data: { workspaceId: A.workspaceId, name }, select: { id: true } })).id;

  grantedOpportunity = await opp("Work they were given");
  invisibleOpportunity = await opp("Work they were not given");

  visibleTask = (
    await observer.task.create({
      data: { workspaceId: A.workspaceId, title: "Inside their own anchor", opportunityId: grantedOpportunity },
      select: { id: true },
    })
  ).id;
  invisibleTask = (
    await observer.task.create({
      data: { workspaceId: A.workspaceId, title: "Somebody else's work", opportunityId: invisibleOpportunity },
      select: { id: true },
    })
  ).id;

  await observer.workspaceMember.updateMany({
    where: { workspaceId: A.workspaceId, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  await observer.recordGrant.create({
    data: {
      workspaceId: A.workspaceId,
      userId: A.memberId,
      anchorType: "opportunity",
      anchorId: grantedOpportunity,
      grantedById: A.ownerId,
    },
  });
});

beforeEach(async () => {
  // Several actions per case, as one person: without this the mutation limiter
  // decides what passes rather than the boundary under test.
  await resetRateLimit("mutation", { user: A.memberId, workspace: A.workspaceId });
  await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId });
});

after(async () => {
  await cleanupTenants([A]);
  await observer.$disconnect();
});

describe("a server action carries the caller's restriction", () => {
  test("creating a task on an anchor they cannot see is refused", pgOnly ?? {}, async () => {
    const { createTask } = await import("../../src/lib/actions/tasks");
    const result = await runAsTestIdentity(A.memberId, () =>
      createTask({
        workspaceId: A.workspaceId,
        title: "Planted inside somebody else's pursuit",
        opportunityId: invisibleOpportunity,
      }),
    );

    assert.equal(result.ok, false, "a restricted member created work on an anchor they cannot see");

    const planted = await observer.task.findFirst({
      where: { workspaceId: A.workspaceId, title: "Planted inside somebody else's pursuit" },
      select: { id: true },
    });
    assert.equal(planted, null, "the row was written even though the action reported failure");
  });

  test("editing a record they cannot see is not found", pgOnly ?? {}, async () => {
    // requireRecordAccess is the guard, and it opens its own context. An
    // invisible record must answer exactly as a nonexistent one.
    const { updateTask } = await import("../../src/lib/actions/tasks");
    const result = await runAsTestIdentity(A.memberId, () =>
      updateTask(invisibleTask, { title: "Renamed by somebody who cannot see it" }),
    );

    assert.equal(result.ok, false, "a restricted member edited a record outside their scope");

    const after = await observer.task.findFirst({ where: { id: invisibleTask }, select: { title: true } });
    assert.equal(after?.title, "Somebody else's work", "the invisible record was modified");
  });

  test("re-parenting their own task onto an invisible anchor is refused", pgOnly ?? {}, async () => {
    const { updateTask } = await import("../../src/lib/actions/tasks");
    const result = await runAsTestIdentity(A.memberId, () =>
      updateTask(visibleTask, { opportunityId: invisibleOpportunity }),
    );

    assert.equal(result.ok, false, "a restricted member moved a record onto an anchor they cannot see");

    const after = await observer.task.findFirst({
      where: { id: visibleTask },
      select: { opportunityId: true },
    });
    assert.equal(
      after?.opportunityId,
      grantedOpportunity,
      "the record was re-parented onto work the member cannot see",
    );
  });

  test("what they were given still works", pgOnly ?? {}, async () => {
    // Every denial above is paired with this: a boundary that also breaks the
    // work is not a boundary, it is an outage.
    const { createTask, updateTask } = await import("../../src/lib/actions/tasks");

    const created = await runAsTestIdentity(A.memberId, () =>
      createTask({
        workspaceId: A.workspaceId,
        title: "Their own next step",
        opportunityId: grantedOpportunity,
      }),
    );
    assert.equal(created.ok, true, `a restricted member cannot work inside their own anchor: ${created.ok ? "" : created.error}`);

    const renamed = await runAsTestIdentity(A.memberId, () =>
      updateTask(visibleTask, { title: "Renamed by the person doing the work" }),
    );
    assert.equal(renamed.ok, true, "a restricted member cannot edit work inside their own anchor");

    if (created.ok && created.data) {
      await observer.task.delete({ where: { id: created.data.id } });
    }
    await observer.task.update({ where: { id: visibleTask }, data: { title: "Inside their own anchor" } });
  });
});

describe("full-workspace members are unaffected", () => {
  test("the owner still creates and edits anywhere in the workspace", pgOnly ?? {}, async () => {
    const { createTask, updateTask } = await import("../../src/lib/actions/tasks");

    const created = await runAsTestIdentity(A.ownerId, () =>
      createTask({
        workspaceId: A.workspaceId,
        title: "Owner's task on the other pursuit",
        opportunityId: invisibleOpportunity,
      }),
    );
    assert.equal(created.ok, true, "a full-workspace member lost access to their own workspace");

    const edited = await runAsTestIdentity(A.ownerId, () =>
      updateTask(invisibleTask, { title: "Somebody else's work" }),
    );
    assert.equal(edited.ok, true, "a full-workspace member cannot edit a record they can see");

    if (created.ok && created.data) {
      await observer.task.delete({ where: { id: created.data.id } });
    }
  });
});
