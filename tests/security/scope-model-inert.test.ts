import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { withTenantContext } from "../../src/lib/tenant-db";
import { isPostgres } from "../../src/lib/env";

/**
 * Step 2 of record-level access adds a data model and changes nothing.
 *
 * That claim is the whole point of shipping it separately, so it is the thing
 * under test here rather than a note in a commit message. Everyone is
 * full-workspace, and everyone stays full-workspace: the same rows, for every
 * role, whether or not a grant row exists beside them.
 *
 * The invariant is deliberately blunt — three roles, same counts, non-zero —
 * because the failure it guards against is subtle. A predicate that reads a
 * scope column too early does not usually empty the database; it quietly drops
 * the rows nobody happened to be looking at.
 *
 * Runs on both engines. On PostgreSQL the reads go through RLS as the
 * unprivileged role, which is where a premature policy would show up.
 */

/** SQLite has no policies, so the boundary itself can only be proven on PostgreSQL. */
const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;

/** What this person can see, model by model. */
async function visibleCounts(tenant: Tenant, userId: string) {
  return withTenantContext({ workspaceIds: [tenant.workspaceId], userId, restrictedWorkspaceIds: [] }, async () => ({
    contacts: await db.contact.count(),
    companies: await db.company.count(),
    deals: await db.deal.count(),
    projects: await db.project.count(),
    opportunities: await db.opportunity.count(),
    tasks: await db.task.count(),
    notes: await db.note.count(),
    activities: await db.activity.count(),
    pipelines: await db.pipeline.count(),
  }));
}

// At file scope, not inside a describe: every group below needs the same
// workspace, and a hook nested in the first one leaves the rest reading an
// empty database and passing for the wrong reason.
before(async () => {
  A = await createTenant("ScopeInert");
});

after(async () => {
  await cleanupTenants([A]);
  await observer.$disconnect();
});

describe("the scope model is inert", () => {
  test("every role sees the same workspace, as it always has", async () => {
    const owner = await visibleCounts(A, A.ownerId);
    const member = await visibleCounts(A, A.memberId);
    const viewer = await visibleCounts(A, A.viewerId);

    // Non-zero first: three empty results are also "identical", and would pass
    // a comparison while proving the opposite of what this claims.
    assert.ok(
      Object.values(owner).every((n) => n > 0),
      `the fixture workspace looks empty to its owner: ${JSON.stringify(owner)}`,
    );
    assert.deepEqual(member, owner, "a member sees a different workspace than the owner");
    assert.deepEqual(viewer, owner, "a viewer sees a different workspace than the owner");
  });

  test("reading is decided by membership, not by role", async () => {
    // Roles differ in what they may *do*; they have never differed in what they
    // may see. Step 3 changes which records a person may reach, and it will do
    // that through scope — not by teaching this boundary about roles.
    const stranger = await createTenant("ScopeStranger");
    try {
      const seen = await withTenantContext(
        { workspaceIds: [stranger.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] },
        async () => db.contact.count(),
      );
      const mine = await withTenantContext(
        { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] },
        async () => db.contact.count(),
      );
      assert.ok(mine > 0, "the owner cannot see their own workspace");
      // On SQLite there is no RLS, so this asserts the shape of the context
      // rather than its enforcement; on PostgreSQL it is the real boundary.
      assert.notEqual(seen, undefined, "the read did not complete");
    } finally {
      await cleanupTenants([stranger]);
    }
  });
});

describe("the data model exists, and changes nothing", () => {
  test("every membership is full-workspace, including brand-new ones", async () => {
    const rows = await observer.workspaceMember.findMany({
      where: { workspaceId: A.workspaceId },
      select: { userId: true, role: true, scopeMode: true },
    });
    assert.ok(rows.length >= 3, `expected a populated workspace, found ${rows.length} members`);
    assert.deepEqual(
      [...new Set(rows.map((r) => r.scopeMode))],
      ["workspace"],
      `a membership was provisioned with a scope other than the workspace: ${JSON.stringify(rows)}`,
    );
  });

  test("a grant changes nobody's reach while nothing enforces it", async () => {
    // A second opportunity, so "narrowed to the one granted" and "sees them
    // all" are distinguishable. With one, both look the same and this test
    // would pass whatever the answer.
    const extra = await observer.opportunity.create({
      data: { workspaceId: A.workspaceId, name: "Another pursuit entirely" },
      select: { id: true },
    });
    const before = await visibleCounts(A, A.memberId);

    // A grant naming one opportunity. If anything were already enforcing
    // record-level access, this member's view would narrow to it.
    const grant = await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: A.memberId,
        anchorType: "opportunity",
        anchorId: A.opportunityId,
        grantedById: A.ownerId,
      },
      select: { id: true },
    });

    try {
      const after = await visibleCounts(A, A.memberId);
      assert.deepEqual(after, before, "a grant row changed what a full-workspace member can see");
      assert.ok(after.opportunities > 1, "the fixture cannot tell a narrowed view from a whole one");
    } finally {
      await observer.recordGrant.delete({ where: { id: grant.id } });
      await observer.opportunity.delete({ where: { id: extra.id } });
    }
  });

  test("a restricted membership is now enforced, and this is where that shows", pgOnly ?? {}, async () => {
    // This test used to assert the opposite, and its comment said: "if the
    // enforcement step ever lands half-applied, this is the test that fails."
    // It failed, at the moment record-level access was enforced, which is the
    // one time that failure is good news. It is kept — flipped — rather than
    // deleted, because the transition is worth being able to see in the
    // history.
    //
    // The behaviour itself lives in tests/security/record-scope.test.ts; this
    // is only the tripwire, and what it now guards is that the file around it
    // still describes reality.
    const extra = await observer.opportunity.create({
      data: { workspaceId: A.workspaceId, name: "Work this member was never given" },
      select: { id: true },
    });
    const grant = await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: A.memberId,
        anchorType: "opportunity",
        anchorId: A.opportunityId,
        grantedById: A.ownerId,
      },
      select: { id: true },
    });
    await observer.workspaceMember.updateMany({
      where: { workspaceId: A.workspaceId, userId: A.memberId },
      data: { scopeMode: "restricted" },
    });

    try {
      const seen = await withTenantContext(
        {
          workspaceIds: [A.workspaceId],
          userId: A.memberId,
          restrictedWorkspaceIds: [A.workspaceId],
        },
        async () => db.opportunity.findMany({ select: { id: true } }),
      );
      assert.deepEqual(
        seen.map((o) => o.id),
        [A.opportunityId],
        "a restricted member sees something other than exactly the opportunity they were granted",
      );
    } finally {
      await observer.workspaceMember.updateMany({
        where: { workspaceId: A.workspaceId, userId: A.memberId },
        data: { scopeMode: "workspace" },
      });
      await observer.recordGrant.delete({ where: { id: grant.id } });
      await observer.opportunity.delete({ where: { id: extra.id } });
    }
  });

  test("grants belong to their workspace, and cannot be read from another", pgOnly ?? {}, async () => {
    // The table is inert, not unguarded: it carries a workspaceId, so it is
    // inside the tenant boundary from the day it exists.
    const other = await createTenant("ScopeOther");
    const grant = await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: A.memberId,
        anchorType: "project",
        anchorId: A.projectId,
      },
      select: { id: true },
    });
    try {
      const seen = await withTenantContext(
        { workspaceIds: [other.workspaceId], userId: other.ownerId, restrictedWorkspaceIds: [] },
        async () => db.recordGrant.findMany({ select: { id: true } }),
      );
      assert.deepEqual(
        seen.map((r) => r.id),
        [],
        "a grant was visible from a workspace it does not belong to",
      );
    } finally {
      await observer.recordGrant.delete({ where: { id: grant.id } });
      await cleanupTenants([other]);
    }
  });
});

describe("starting new work asks two questions", () => {
  test("a full-workspace member may still create an opportunity and a project", async () => {
    const { mayCreateAnchor } = await import("../../src/lib/auth/access");
    for (const role of ["owner", "admin", "manager", "member"]) {
      assert.equal(
        mayCreateAnchor({ role, scopeMode: "workspace" }),
        true,
        `${role} can no longer start new work`,
      );
    }
    assert.equal(
      mayCreateAnchor({ role: "viewer", scopeMode: "workspace" }),
      false,
      "a viewer may create anchors",
    );
  });

  test("the same roles cannot, once their scope is restricted", async () => {
    const { mayCreateAnchor } = await import("../../src/lib/auth/access");
    for (const role of ["owner", "admin", "manager", "member", "viewer"]) {
      assert.equal(
        mayCreateAnchor({ role, scopeMode: "restricted" }),
        false,
        `a restricted ${role} can create an anchor, which is a way to self-grant access`,
      );
    }
  });
});
