import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { isPostgres } from "../../src/lib/env";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { suspendAccount, grantComplimentaryPlan } from "../../src/lib/actions/admin";

/**
 * The admin panel's boundaries, enforced by the database rather than by us.
 *
 * ACTOR    `db` — the application's client, connected as `tinycrm_app` with
 *          NOBYPASSRLS. Every attempt under test runs here, so a policy that
 *          does not exist shows up as a success rather than as a refusal.
 * OBSERVER `observer` — privileged, builds the world and reads ground truth.
 *          It never performs the operation under test, because a harness bound
 *          by the same policies cannot tell a refused write from a no-op.
 *
 * PostgreSQL only: SQLite has no policies, so there is no boundary here to
 * test and a passing run would be vacuous.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let admin: Tenant;
let ordinary: Tenant;
let other: Tenant;

before(async () => {
  admin = await createTenant("RlsAdmin", { plan: "free" });
  ordinary = await createTenant("RlsOrdinary", { plan: "free" });
  other = await createTenant("RlsOther", { plan: "free" });
  // Written by the observer: the application role has no INSERT policy on this
  // table, which is itself asserted below.
  await observer.platformAdmin.create({ data: { userId: admin.ownerId, note: "rls suite" } });
});

after(async () => {
  await observer.platformAdmin.deleteMany({
    where: { userId: { in: [admin.ownerId, ordinary.ownerId, other.ownerId] } },
  });
  await observer.planGrant.deleteMany({
    where: { userId: { in: [ordinary.ownerId, other.ownerId] } },
  });
  await cleanupTenants([admin, ordinary, other]);
  await observer.$disconnect();
});

/** Runs as a given identity, inside that identity's own tenant context. */
function asUser<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
  return runAsTestIdentity(tenant.ownerId, () =>
    withTenantContext(
      { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
      fn,
    ),
  );
}

describe("PlatformAdmin is not writable by the application role", () => {
  test("an ordinary user cannot insert themselves", pgOnly, async () => {
    let refused = false;
    try {
      await asUser(ordinary, () =>
        db.platformAdmin.create({ data: { userId: ordinary.ownerId, note: "self-granted" } }),
      );
    } catch {
      refused = true;
    }
    assert.ok(refused, "the application role inserted a PlatformAdmin row");
    assert.equal(
      await observer.platformAdmin.count({ where: { userId: ordinary.ownerId } }),
      0,
      "an ordinary user holds administration",
    );
  });

  test("even the admin cannot add another admin through the application role", pgOnly, async () => {
    // Administration is established by migration, deliberately. An admin who
    // could appoint another admin from inside the product is a privilege
    // escalation path that no audit entry makes safe.
    let refused = false;
    try {
      await asUser(admin, () =>
        db.platformAdmin.create({ data: { userId: other.ownerId, note: "appointed" } }),
      );
    } catch {
      refused = true;
    }
    assert.ok(refused, "an admin appointed another admin at runtime");
    assert.equal(await observer.platformAdmin.count({ where: { userId: other.ownerId } }), 0);
  });

  test("an ordinary user cannot delete the admin's row", pgOnly, async () => {
    await asUser(ordinary, () =>
      db.platformAdmin.deleteMany({ where: { userId: admin.ownerId } }).catch(() => undefined),
    );
    assert.equal(
      await observer.platformAdmin.count({ where: { userId: admin.ownerId } }),
      1,
      "an ordinary user removed the administrator",
    );
  });

  test("an ordinary user cannot even see that the table has rows", pgOnly, async () => {
    const seen = await asUser(ordinary, () => db.platformAdmin.findMany({ select: { userId: true } }));
    assert.deepEqual(seen, [], "an ordinary user enumerated the administrators");
  });

  test("the admin sees exactly their own row, and no others", pgOnly, async () => {
    await observer.platformAdmin.create({ data: { userId: other.ownerId, note: "second admin" } });
    try {
      const seen = await asUser(admin, () => db.platformAdmin.findMany({ select: { userId: true } }));
      assert.deepEqual(
        seen.map((r) => r.userId),
        [admin.ownerId],
        "the admin enumerated administrators other than themselves",
      );
    } finally {
      await observer.platformAdmin.deleteMany({ where: { userId: other.ownerId } });
    }
  });
});

describe("cross-tenant reads are the admin's alone", () => {
  test("an ordinary user cannot read another tenant's workspace", pgOnly, async () => {
    const seen = await asUser(ordinary, () =>
      db.workspace.findMany({ where: { id: other.workspaceId }, select: { id: true } }),
    );
    assert.deepEqual(seen, [], "an ordinary user read another tenant's workspace");
  });

  test("an ordinary user naming another user's id gets nothing back", pgOnly, async () => {
    // The direct-object attempt: a real id, supplied deliberately, from a
    // session that has no business with it.
    const members = await asUser(ordinary, () =>
      db.workspaceMember.findMany({ where: { userId: other.ownerId }, select: { workspaceId: true } }),
    );
    assert.deepEqual(members, [], "an ordinary user enumerated another user's memberships");
  });

  test("the admin may read any workspace and its members", pgOnly, async () => {
    const workspaces = await asUser(admin, () =>
      db.workspace.findMany({ where: { id: other.workspaceId }, select: { id: true } }),
    );
    assert.equal(workspaces.length, 1, "the admin could not read a customer's workspace");

    const members = await asUser(admin, () =>
      db.workspaceMember.findMany({ where: { userId: other.ownerId }, select: { workspaceId: true } }),
    );
    assert.ok(members.length >= 1, "the admin could not read a customer's memberships");
  });

  test("the admin's read access is read-only", pgOnly, async () => {
    const before = await observer.workspace.findUniqueOrThrow({
      where: { id: other.workspaceId }, select: { name: true },
    });
    await asUser(admin, () =>
      db.workspace
        .update({ where: { id: other.workspaceId }, data: { name: "renamed by admin" } })
        .catch(() => undefined),
    );
    const after = await observer.workspace.findUniqueOrThrow({
      where: { id: other.workspaceId }, select: { name: true },
    });
    assert.equal(after.name, before.name, "the admin wrote to a customer's workspace");
  });
});

describe("the administrative audit trail is readable by the admin who wrote it", () => {
  test("an admin action's entry is visible to that admin under RLS", pgOnly, async () => {
    const done = await runAsTestIdentity(admin.ownerId, () =>
      grantComplimentaryPlan({ userId: other.ownerId, plan: "pro", reason: "rls readability" }),
    );
    assert.equal(done.ok, true, `grant failed: ${done.ok ? "" : done.error}`);

    const seen = await asUser(admin, () =>
      db.auditLog.findMany({
        where: { action: "admin.plan_grant_created", entityId: other.ownerId },
        select: { summary: true, actorId: true, workspaceId: true },
      }),
    );
    assert.equal(seen.length, 1, "the admin cannot read their own administrative entry");
    assert.equal(seen[0]!.workspaceId, null);
    assert.equal(seen[0]!.actorId, admin.ownerId);
  });

  test("an ordinary user cannot read the administrative trail", pgOnly, async () => {
    const seen = await asUser(ordinary, () =>
      db.auditLog.findMany({
        where: { action: "admin.plan_grant_created", entityId: other.ownerId },
        select: { summary: true },
      }),
    );
    assert.deepEqual(seen, [], "an ordinary user read the administrative audit trail");
  });

  test("the target of an administrative action cannot read the entry about them", pgOnly, async () => {
    // Orphaned rows are visible to their actor only, so the customer does not
    // see the operator's note about their own account.
    const seen = await asUser(other, () =>
      db.auditLog.findMany({
        where: { action: "admin.plan_grant_created", entityId: other.ownerId },
        select: { summary: true },
      }),
    );
    assert.deepEqual(seen, [], "a customer read an administrative entry about themselves");
  });
});

describe("suspension through the restricted role", () => {
  test("the admin may suspend a customer; an ordinary user may not", pgOnly, async () => {
    const refused = await runAsTestIdentity(ordinary.ownerId, () =>
      suspendAccount({ userId: other.ownerId, reason: "not mine to do" }),
    );
    assert.equal(refused.ok, false, "an ordinary user suspended another account");
    let target = await observer.user.findUniqueOrThrow({
      where: { id: other.ownerId }, select: { deactivatedAt: true, deactivatedReason: true },
    });
    assert.equal(target.deactivatedAt, null);

    const allowed = await runAsTestIdentity(admin.ownerId, () =>
      suspendAccount({ userId: other.ownerId, reason: "verified abuse report" }),
    );
    assert.equal(allowed.ok, true, `admin suspend failed: ${allowed.ok ? "" : allowed.error}`);
    target = await observer.user.findUniqueOrThrow({
      where: { id: other.ownerId }, select: { deactivatedAt: true, deactivatedReason: true },
    });
    assert.ok(target.deactivatedAt, "the admin's suspension did not land");
    assert.equal(target.deactivatedReason, "verified abuse report");
  });
});
