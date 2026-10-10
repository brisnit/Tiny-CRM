import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { grantComplimentaryPlan, revokeComplimentaryPlan } from "../../src/lib/actions/admin";
import { activeGrantWhere, effectiveFrom, GRANT_SELECT } from "../../src/lib/plan-grants";
import { applyPlanChange } from "../../src/lib/entitlements";

/**
 * What a complimentary grant does, and — mostly — what it must never do.
 *
 * Three properties carry the design, and each is asserted in the direction
 * that would hurt:
 *
 *   1. A grant **adds**. It can never reduce access, and never touches
 *      `User.plan`, which is what Stripe owns.
 *   2. Expiry is resolved **on read**, so a lapsed grant stops applying with
 *      no job having run.
 *   3. A verified webhook and a live grant **coexist**. The webhook rewrites
 *      the stored column; the grant is a different row; neither erases the
 *      other.
 */

/** The effective entitlement, read the way the application reads it. */
async function effectiveFor(userId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, planGrants: { where: activeGrantWhere(), select: GRANT_SELECT } },
  });
  return effectiveFrom(user.plan, user.planGrants);
}

let admin: Tenant;
let free: Tenant;
let pro: Tenant;
let lifetime: Tenant;

before(async () => {
  admin = await createTenant("GrantAdmin", { plan: "free" });
  free = await createTenant("GrantFree", { plan: "free" });
  pro = await createTenant("GrantPro", { plan: "pro" });
  lifetime = await createTenant("GrantLifetime", { plan: "legacy_lifetime" });
  // Stored as the pre-Stripe alias, which is what the real Lifetime accounts
  // carry: `planFor` resolves "lifetime" -> legacy_lifetime. Set directly
  // because the fixture's type only admits resolved plan ids, and the alias is
  // precisely what must not be mishandled.
  await db.user.update({ where: { id: lifetime.ownerId }, data: { plan: "lifetime" } });
  await db.platformAdmin.create({ data: { userId: admin.ownerId } });
});

after(async () => {
  await db.platformAdmin.deleteMany({ where: { userId: admin.ownerId } });
  await db.planGrant.deleteMany({
    where: { userId: { in: [free.ownerId, pro.ownerId, lifetime.ownerId] } },
  });
  await cleanupTenants([admin, free, pro, lifetime]);
  await db.$disconnect();
});

const asAdmin = <T>(fn: () => Promise<T>) => runAsTestIdentity(admin.ownerId, fn);

describe("granting complimentary access", () => {
  test("a Free account gains Pro, and the stored plan is untouched", async () => {
    const result = await asAdmin(() => grantComplimentaryPlan({
      userId: free.ownerId, plan: "pro", reason: "design partner",
    }));
    assert.equal(result.ok, true, `grant failed: ${result.ok ? "" : result.error}`);

    const after = await effectiveFor(free.ownerId);
    assert.equal(after.effective, "pro", "the grant did not take effect");
    assert.equal(after.granted, "pro");
    assert.equal(
      after.stored, "free",
      "the grant wrote the stored plan, which Stripe owns and would overwrite",
    );
    assert.equal(after.underlying, "free");
  });

  test("the audit entry is written in the same transaction and names the reason", async () => {
    const entry = await db.auditLog.findFirst({
      where: { action: "admin.plan_grant_created", entityId: free.ownerId },
      orderBy: { createdAt: "desc" },
      select: { actorId: true, workspaceId: true, summary: true, metadata: true },
    });
    assert.ok(entry, "granting wrote no audit entry");
    // Visible to the admin under the existing policy: orphaned rows are
    // readable by the actor who wrote them.
    assert.equal(entry.actorId, admin.ownerId, "the entry is not attributed to the admin");
    assert.equal(entry.workspaceId, null, "the entry claims a workspace it has no business in");
    assert.match(entry.summary, /complimentary pro/i);
    assert.match(entry.metadata ?? "", /design partner/);
    // The question someone will ask of this entry later.
    assert.match(entry.metadata ?? "", /charges nothing|creates no subscription/i);
  });

  test("revoking restores the underlying entitlement without a restore step", async () => {
    const result = await asAdmin(() => revokeComplimentaryPlan({
      userId: free.ownerId, reason: "pilot ended",
    }));
    assert.equal(result.ok, true, `revoke failed: ${result.ok ? "" : result.error}`);

    const after = await effectiveFor(free.ownerId);
    assert.equal(after.effective, "free", "revoking did not restore the underlying plan");
    assert.equal(after.grant, null);
    // The row survives: history of who was given what, and why.
    const revoked = await db.planGrant.findFirst({
      where: { userId: free.ownerId }, orderBy: { grantedAt: "desc" },
      select: { revokedAt: true, revokedReason: true, reason: true },
    });
    assert.ok(revoked?.revokedAt, "the grant was deleted rather than revoked");
    assert.equal(revoked.revokedReason, "pilot ended");
    assert.equal(revoked.reason, "design partner", "the original reason was overwritten");
  });
});

describe("a grant can only ever add", () => {
  test("Lifetime is refused outright, and keeps its entitlement", async () => {
    const before = await effectiveFor(lifetime.ownerId);
    assert.equal(before.underlying, "legacy_lifetime");

    const result = await asAdmin(() => grantComplimentaryPlan({
      userId: lifetime.ownerId, plan: "plus", reason: "should be refused",
    }));
    assert.equal(result.ok, false, "a legacy account was given a weaker complimentary plan");

    const after = await effectiveFor(lifetime.ownerId);
    assert.equal(after.effective, "legacy_lifetime", "a grant eroded a Lifetime entitlement");
    assert.equal(await db.planGrant.count({ where: { userId: lifetime.ownerId } }), 0);
  });

  test("a grant weaker than the paid plan is refused rather than silently stored", async () => {
    const result = await asAdmin(() => grantComplimentaryPlan({
      userId: pro.ownerId, plan: "plus", reason: "should be refused",
    }));
    assert.equal(result.ok, false, "a Pro account was given a weaker complimentary plan");
    const after = await effectiveFor(pro.ownerId);
    assert.equal(after.effective, "pro", "a weaker grant changed a stronger plan");
  });

  test("Lifetime is not offered as a grantable plan at all", async () => {
    const { GRANTABLE_PLANS } = await import("../../src/lib/plans");
    assert.deepEqual([...GRANTABLE_PLANS], ["plus", "pro"]);
    const result = await asAdmin(() => grantComplimentaryPlan({
      userId: free.ownerId, plan: "legacy_lifetime", reason: "not allowed",
    }));
    assert.equal(result.ok, false, "a legacy plan was grantable");
  });
});

describe("expiry is resolved on read", () => {
  test("a grant that has lapsed stops applying, with no job having run", async () => {
    // Written directly with a past expiry: the action refuses to create one,
    // and what is under test is the *read*, not the form validation.
    await db.planGrant.create({
      data: {
        userId: free.ownerId, plan: "pro", reason: "expired pilot",
        expiresAt: new Date(Date.now() - 60_000), grantedById: admin.ownerId,
      },
    });
    const after = await effectiveFor(free.ownerId);
    assert.equal(after.effective, "free", "an expired grant was still honoured");
    assert.equal(after.grant, null);
  });

  test("a grant expiring in the future still applies", async () => {
    await db.planGrant.deleteMany({ where: { userId: free.ownerId } });
    await db.planGrant.create({
      data: {
        userId: free.ownerId, plan: "pro", reason: "live pilot",
        expiresAt: new Date(Date.now() + 3_600_000), grantedById: admin.ownerId,
      },
    });
    const after = await effectiveFor(free.ownerId);
    assert.equal(after.effective, "pro", "a live grant was ignored");
  });

  test("a revoked grant is ignored even before its expiry", async () => {
    await db.planGrant.updateMany({
      where: { userId: free.ownerId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "ended early" },
    });
    const after = await effectiveFor(free.ownerId);
    assert.equal(after.effective, "free", "a revoked grant outlived its revocation");
  });
});

describe("a Stripe webhook and a grant coexist", () => {
  test("a webhook rewriting the stored plan does not erase a live grant", async () => {
    await db.planGrant.deleteMany({ where: { userId: free.ownerId } });
    await asAdmin(() => grantComplimentaryPlan({
      userId: free.ownerId, plan: "pro", reason: "coexistence check",
    }));
    assert.equal((await effectiveFor(free.ownerId)).effective, "pro");

    // The verified webhook's own path, not a stand-in.
    await applyPlanChange(free.ownerId, "plus", { status: "active" });

    const after = await effectiveFor(free.ownerId);
    assert.equal(after.stored, "plus", "the webhook did not write the stored plan");
    assert.equal(after.granted, "pro", "the webhook erased the grant");
    assert.equal(after.effective, "pro", "the stronger of the two did not win");
  });

  test("when the paid plan overtakes the grant, the paid plan wins and the grant is inert", async () => {
    await applyPlanChange(free.ownerId, "pro", { status: "active" });
    const after = await effectiveFor(free.ownerId);
    assert.equal(after.effective, "pro");
    // The panel must not claim the grant is doing something it is not.
    assert.equal(after.grant, null, "an inert grant was reported as in force");
  });

  test("a webhook downgrade falls back to the grant, not to free", async () => {
    await applyPlanChange(free.ownerId, "free", { status: "canceled" });
    const after = await effectiveFor(free.ownerId);
    assert.equal(after.stored, "free", "the cancellation did not land");
    assert.equal(after.effective, "pro", "a cancelled subscription took the grant with it");
    assert.equal(after.granted, "pro");
  });
});
