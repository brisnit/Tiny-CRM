import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { withTenantContext, NO_RECORD_READS } from "../../src/lib/tenant-db";
import { isPostgres } from "../../src/lib/env";

/**
 * Who may rewrite a membership, according to the database.
 *
 * Every membership write in the product goes through `changeMemberRole`,
 * `removeMember` or `setMemberScope`, and each of those requires
 * `members:manage`, enforces owner safety, and — since Step 4 — refuses a
 * restricted actor. That is the application boundary and it holds.
 *
 * This file is about the other one. `WorkspaceMember` carried a restrictive
 * policy for INSERT alone, so at the database layer the table was governed for
 * UPDATE and DELETE by the ordinary workspace rule: any member's own session
 * could rewrite any membership in its workspace. The INSERT arm was no
 * narrower in practice — "the actor already belongs here" admits a member
 * minting an owner membership for somebody else.
 *
 * None of it is reachable through the product. All of it is reachable by
 * anything that can run a statement as `tinycrm_app` with a session context,
 * which is precisely the threat every other policy in this directory is
 * written against. The gap is pre-existing rather than anything Team-2
 * introduced; it was found by the canary harness, before the canary ran.
 *
 * ACTOR    `db` — the application's client, `tinycrm_app`, NOBYPASSRLS.
 * OBSERVER `observer` — privileged; builds the world, never performs the
 *          operation under test.
 *
 * Row counts, not exceptions. A USING violation does not raise: PostgreSQL
 * narrows what the statement can see and reports zero rows affected. Zero is
 * the denial; anything else is the hole, and the count says how big.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;
let B: Tenant;

/** Membership row ids, resolved once the tenant exists. */
const membership = { owner: "", restricted: "", bystander: "" };
/** A user with no membership anywhere — the accomplice an INSERT would enrol. */
let accomplice = { id: "", email: "" };

/**
 * Puts the fixture back exactly as `before` left it.
 *
 * While the gap is open these tests genuinely succeed at what they attempt —
 * one of them deletes a colleague's membership — so each restores the world
 * before asserting. Once the policy lands every write is a no-op and this
 * becomes one too; until then it is what stops the first red test poisoning
 * the positive controls that follow it.
 */
async function restoreWorld(): Promise<void> {
  await observer.workspaceMember.deleteMany({
    where: { workspaceId: A.workspaceId, userId: accomplice.id },
  });
  await observer.workspaceMember.updateMany({
    where: { id: membership.owner }, data: { role: "owner", scopeMode: "workspace" },
  });
  await observer.workspaceMember.updateMany({
    where: { id: membership.restricted }, data: { role: "member", scopeMode: "restricted" },
  });
  const bystander = await observer.workspaceMember.findFirst({
    where: { id: membership.bystander }, select: { id: true },
  });
  if (bystander) {
    await observer.workspaceMember.updateMany({
      where: { id: membership.bystander }, data: { role: "viewer", scopeMode: "workspace" },
    });
  } else {
    await observer.workspaceMember.create({
      data: {
        id: membership.bystander, workspaceId: A.workspaceId,
        userId: A.viewerId, role: "viewer", scopeMode: "workspace",
      },
    });
  }
}

/** Runs one statement as the restricted member, the way a request would. */
function asRestricted<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext(
    { workspaceIds: [A.workspaceId], userId: A.memberId, restrictedWorkspaceIds: [A.workspaceId] },
    fn,
  );
}

/** Runs one statement as the workspace owner: full scope, may administer members. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext(
    { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: NO_RECORD_READS },
    fn,
  );
}

before(async () => {
  A = await createTenant("MemberWrite");
  B = await createTenant("MemberWriteOther");

  const rows = await observer.workspaceMember.findMany({
    where: { workspaceId: A.workspaceId },
    select: { id: true, userId: true },
  });
  membership.owner = rows.find((r) => r.userId === A.ownerId)?.id ?? "";
  membership.restricted = rows.find((r) => r.userId === A.memberId)?.id ?? "";
  membership.bystander = rows.find((r) => r.userId === A.viewerId)?.id ?? "";

  // The member under test is genuinely restricted, so these are the writes a
  // confined principal can attempt rather than a hypothetical one.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: A.workspaceId, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });

  const user = await observer.user.create({
    data: {
      email: `accomplice-${randomUUID()}@membership.invalid`,
      name: "Accomplice",
      passwordHash: await bcrypt.hash("correct-horse-battery", 4),
      emailVerifiedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  accomplice = user;
});

after(async () => {
  await observer.user.deleteMany({ where: { id: accomplice.id } });
  await cleanupTenants([A, B]);
  await observer.$disconnect();
});

// ---------------------------------------------------------------------------
// The gap
// ---------------------------------------------------------------------------

describe("a restricted member cannot rewrite membership authority", () => {
  test("it cannot lift its own restriction", pgOnly ?? {}, async () => {
    const affected = await asRestricted(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET "scopeMode" = 'workspace' WHERE id = ${membership.restricted}`,
    );
    const after = await observer.workspaceMember.findFirst({
      where: { id: membership.restricted },
      select: { scopeMode: true },
    });
    await restoreWorld();

    assert.equal(affected, 0, "a restricted member changed its own scope directly in the database");
    assert.equal(after?.scopeMode, "restricted", "the row was actually changed");
  });

  test("it cannot promote itself", pgOnly ?? {}, async () => {
    const affected = await asRestricted(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET role = 'owner' WHERE id = ${membership.restricted}`,
    );
    const after = await observer.workspaceMember.findFirst({
      where: { id: membership.restricted },
      select: { role: true },
    });
    await restoreWorld();

    assert.equal(affected, 0, "a restricted member promoted itself directly in the database");
    assert.notEqual(after?.role, "owner", "the row was actually changed");
  });

  test("it cannot restrict the workspace owner", pgOnly ?? {}, async () => {
    const affected = await asRestricted(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET "scopeMode" = 'restricted' WHERE id = ${membership.owner}`,
    );
    const after = await observer.workspaceMember.findFirst({
      where: { id: membership.owner },
      select: { scopeMode: true },
    });
    await restoreWorld();

    assert.equal(affected, 0, "a restricted member confined the owner of the workspace");
    assert.equal(after?.scopeMode, "workspace", "the owner's membership was actually changed");
  });

  test("it cannot change another member's role", pgOnly ?? {}, async () => {
    const affected = await asRestricted(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET role = 'viewer' WHERE id = ${membership.bystander}`,
    );
    await restoreWorld();
    assert.equal(affected, 0, "a restricted member rewrote a colleague's role");
  });

  test("it cannot remove another member", pgOnly ?? {}, async () => {
    const affected = await asRestricted(() =>
      db.$executeRaw`DELETE FROM "WorkspaceMember" WHERE id = ${membership.bystander}`,
    );
    const survivor = await observer.workspaceMember.findFirst({
      where: { id: membership.bystander },
      select: { id: true },
    });
    await restoreWorld();

    assert.equal(affected, 0, "a restricted member removed a colleague from the workspace");
    assert.ok(survivor, "the colleague's membership was actually deleted");
  });

  test("it cannot enrol an accomplice as an owner", pgOnly ?? {}, async () => {
    // The INSERT arm from 004 admits "the actor already belongs to this
    // workspace", which is not the same question as "may the actor administer
    // members" — and the difference is a member minting an owner.
    let affected = 0;
    try {
      affected = await asRestricted(() =>
        db.$executeRaw`
          INSERT INTO "WorkspaceMember"(id, "workspaceId", "userId", role, "scopeMode")
          VALUES (${`m${randomUUID().replace(/-/g, "")}`}, ${A.workspaceId}, ${accomplice.id}, 'owner', 'workspace')`,
      );
    } catch {
      affected = 0;
    }
    const enrolled = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: accomplice.id },
      select: { id: true },
    });
    await restoreWorld();

    assert.equal(affected, 0, "a restricted member enrolled a new owner of the workspace");
    assert.equal(enrolled, null, "the accomplice was actually enrolled");
  });

  test("it cannot reach another workspace's memberships at all", pgOnly ?? {}, async () => {
    // The tenant boundary is older than any of this and must not have moved.
    const affected = await asRestricted(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET role = 'owner' WHERE "workspaceId" = ${B.workspaceId}`,
    );
    assert.equal(affected, 0, "a member of one workspace rewrote memberships in another");
  });
});

// ---------------------------------------------------------------------------
// The flows that must keep working
// ---------------------------------------------------------------------------

describe("legitimate membership administration still works", () => {
  test("an owner may change a member's role", pgOnly ?? {}, async () => {
    const affected = await asOwner(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET role = 'manager' WHERE id = ${membership.bystander}`,
    );
    assert.equal(affected, 1, "the owner could not change a member's role");
    await observer.workspaceMember.updateMany({
      where: { id: membership.bystander }, data: { role: "viewer" },
    });
  });

  test("an owner may change a member's scope", pgOnly ?? {}, async () => {
    const affected = await asOwner(() =>
      db.$executeRaw`UPDATE "WorkspaceMember" SET "scopeMode" = 'restricted' WHERE id = ${membership.bystander}`,
    );
    assert.equal(affected, 1, "the owner could not change a member's scope");
    await observer.workspaceMember.updateMany({
      where: { id: membership.bystander }, data: { scopeMode: "workspace" },
    });
  });

  test("an owner may remove a member", pgOnly ?? {}, async () => {
    const doomed = await observer.user.create({
      data: {
        email: `removable-${randomUUID()}@membership.invalid`,
        name: "Removable",
        passwordHash: await bcrypt.hash("correct-horse-battery", 4),
      },
      select: { id: true },
    });
    const row = await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: doomed.id, role: "member" },
      select: { id: true },
    });

    const affected = await asOwner(() =>
      db.$executeRaw`DELETE FROM "WorkspaceMember" WHERE id = ${row.id}`,
    );
    assert.equal(affected, 1, "the owner could not remove a member");
    await observer.user.deleteMany({ where: { id: doomed.id } });
  });

  test("an owner may enrol somebody directly", pgOnly ?? {}, async () => {
    // The administrator arm of the INSERT rule: this is what "an existing
    // member adds someone" becomes once it asks the right question.
    const affected = await asOwner(() =>
      db.$executeRaw`
        INSERT INTO "WorkspaceMember"(id, "workspaceId", "userId", role, "scopeMode")
        VALUES (${`m${randomUUID().replace(/-/g, "")}`}, ${A.workspaceId}, ${accomplice.id}, 'member', 'workspace')`,
    );
    assert.equal(affected, 1, "an owner could not add a member");
    await observer.workspaceMember.deleteMany({
      where: { workspaceId: A.workspaceId, userId: accomplice.id },
    });
  });

  test("workspace bootstrap still creates the founder's own membership", pgOnly ?? {}, async () => {
    // Through the real provisioning path, which is the only way a workspace is
    // ever created: the id is generated first and the whole graph is written
    // inside a context containing it.
    const founder = await observer.user.create({
      data: {
        email: `founder-${randomUUID()}@membership.invalid`,
        name: "Founder",
        passwordHash: await bcrypt.hash("correct-horse-battery", 4),
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
    const workspace = await provisionWorkspace(founder.id, { name: "Bootstrap check" });

    const own = await observer.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: founder.id },
      select: { role: true },
    });
    assert.equal(own?.role, "owner", "provisioning did not create the founder's membership");

    await observer.workspace.deleteMany({ where: { id: workspace.id } });
    await observer.user.deleteMany({ where: { id: founder.id } });
  });

  test("invitation acceptance still creates the invitee's membership", pgOnly ?? {}, async () => {
    // The whole Step 4 path: issue, redeem, materialize — through the real
    // library and the real server action, with the invitee as the actor.
    const { issueInvitation } = await import("../../src/lib/auth/invitations");
    const { acceptInvitation } = await import("../../src/lib/actions/team");
    const { runAsTestIdentity } = await import("../../src/lib/auth/context");
    const { resetRateLimit } = await import("../../src/lib/rate-limit");

    const invitee = await observer.user.create({
      data: {
        email: `invitee-${randomUUID()}@membership.invalid`,
        name: "Invitee",
        passwordHash: await bcrypt.hash("correct-horse-battery", 4),
        emailVerifiedAt: new Date(),
      },
      select: { id: true, email: true },
    });

    const issued = await issueInvitation({
      workspaceId: A.workspaceId,
      email: invitee.email,
      role: "member",
      invitedById: A.ownerId,
    });

    await resetRateLimit("mutation", { user: invitee.id, workspace: invitee.id, global: invitee.id });
    const accepted = await runAsTestIdentity(invitee.id, () => acceptInvitation(issued.token));
    assert.equal(accepted.ok, true, `acceptance failed: ${JSON.stringify(accepted)}`);

    const joined = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: invitee.id },
      select: { role: true, scopeMode: true },
    });
    assert.ok(joined, "the invitee did not join");
    assert.equal(joined.role, "member");
    assert.equal(joined.scopeMode, "workspace");

    await observer.workspaceMember.deleteMany({
      where: { workspaceId: A.workspaceId, userId: invitee.id },
    });
    await observer.user.deleteMany({ where: { id: invitee.id } });
  });

  test("a restricted member can still read its own membership", pgOnly ?? {}, async () => {
    // SELECT semantics are not what this step changes, and a rule that hid a
    // person's own membership would break every request: the actor's scope is
    // derived from it.
    const rows = await asRestricted(() =>
      db.workspaceMember.findMany({
        where: { workspaceId: A.workspaceId, userId: A.memberId },
        select: { id: true, scopeMode: true },
      }),
    );
    assert.equal(rows.length, 1, "a restricted member cannot see its own membership");
    assert.equal(rows[0].scopeMode, "restricted");
  });
});
