import { test, describe, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { assertSeatAvailable, seatUsage } from "../../src/lib/billing/seats";
import { PLANS } from "../../src/lib/plans";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Seats: the one per-workspace limit, and the one that was advertised for a whole
 * plan generation without ever being enforced.
 *
 * "Up to 5 seats" was on the pricing page. `getEntitlements` computed a
 * `canInviteUsers` flag that had zero callers, and no invitation path consulted a
 * seat count — so the number was decoration. These tests are what make it a
 * limit.
 *
 * Two properties carry most of the weight:
 *
 *   1. **The governing plan is the workspace owner's**, not the inviter's and not
 *      the invitee's. The person paying for the workspace is whose ceiling
 *      applies, which is the only reading that makes sense when billing is per
 *      account and a seat is a place in a workspace.
 *   2. **Pending invitations count when issuing and not when accepting.** Both
 *      directions matter: without the first, ten invitations fit into three seats
 *      and seven people meet a refusal after accepting; with the second, the
 *      invitation being accepted would count itself and the last seat would be
 *      permanently unreachable.
 */

let FREE: Tenant;
let PLUS: Tenant;

/** The fixture seeds owner + member + viewer, so three members exist. */
const FIXTURE_MEMBERS = 3;

async function trimToFixtureMembers(tenant: Tenant) {
  await db.workspaceInvitation.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.workspaceMember.deleteMany({
    where: {
      workspaceId: tenant.workspaceId,
      userId: { notIn: [tenant.ownerId, tenant.memberId, tenant.viewerId] },
    },
  });
}

async function addPendingInvitation(tenant: Tenant, email: string) {
  await db.workspaceInvitation.create({
    data: {
      workspaceId: tenant.workspaceId,
      email,
      role: "member",
      invitedById: tenant.ownerId,
      scopeMode: "workspace",
      scope: "[]",
      tokenHash: `hash-${email}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
    },
  });
}

describe("seats are enforced per workspace from the owner's plan", () => {
  before(async () => {
    FREE = await createTenant("SeatsFree", { plan: "free" });
    PLUS = await createTenant("SeatsPlus", { plan: "plus" });
  });

  after(async () => {
    await cleanupTenants([FREE, PLUS]);
    await db.$disconnect();
  });

  beforeEach(async () => {
    await trimToFixtureMembers(FREE);
    await trimToFixtureMembers(PLUS);
  });

  test("usage reports the owner's ceiling, not the caller's plan", async () => {
    const usage = await seatUsage(FREE.workspaceId);
    assert.equal(usage.limit, PLANS.free.limits.seats, "Free allows one person");
    assert.equal(usage.ownerPlan, "free");
    assert.equal(usage.used, FIXTURE_MEMBERS);

    const plus = await seatUsage(PLUS.workspaceId);
    assert.equal(plus.limit, PLANS.plus.limits.seats);
    assert.equal(plus.ownerPlan, "plus");
  });

  test("a workspace already over its ceiling refuses another member", async () => {
    // The Free fixture has three members against a ceiling of one, which is
    // exactly the shape an account that downgraded would be in.
    await assert.rejects(
      () => assertSeatAvailable(FREE.workspaceId),
      /allows 1 person/,
      "a full workspace refuses, and says what the ceiling is",
    );
  });

  test("a workspace with room admits another member", async () => {
    // Plus allows 3 and the fixture has exactly 3, so make room first.
    await db.workspaceMember.deleteMany({
      where: { workspaceId: PLUS.workspaceId, userId: PLUS.viewerId },
    });
    const usage = await assertSeatAvailable(PLUS.workspaceId);
    assert.equal(usage.used, FIXTURE_MEMBERS - 1);
    assert.ok(usage.used < usage.limit);
  });

  test("ISSUING counts outstanding invitations, so a workspace cannot be oversubscribed", async () => {
    await db.workspaceMember.deleteMany({
      where: { workspaceId: PLUS.workspaceId, userId: { in: [PLUS.memberId, PLUS.viewerId] } },
    });
    // One member, ceiling of three: room for two more.
    await addPendingInvitation(PLUS, "first@invite.test");
    await addPendingInvitation(PLUS, "second@invite.test");

    const usage = await seatUsage(PLUS.workspaceId);
    assert.equal(usage.used, 1);
    assert.equal(usage.pending, 2);

    await assert.rejects(
      () => assertSeatAvailable(PLUS.workspaceId, { countPending: true }),
      /invitations outstanding/,
      "a third invitation is refused while two are outstanding against three seats",
    );
  });

  test("ACCEPTING does not count outstanding invitations, so the last seat is reachable", async () => {
    await db.workspaceMember.deleteMany({
      where: { workspaceId: PLUS.workspaceId, userId: { in: [PLUS.memberId, PLUS.viewerId] } },
    });
    // One member and one outstanding invitation against three seats. The person
    // accepting is the outstanding invitation: counting it would make them
    // compete with themselves.
    await addPendingInvitation(PLUS, "accepting@invite.test");

    const usage = await assertSeatAvailable(PLUS.workspaceId);
    assert.equal(usage.pending, 1, "the invitation is outstanding");
    assert.ok(usage.used < usage.limit, "and acceptance is still permitted");
  });

  test("an expired invitation stops holding a seat", async () => {
    await db.workspaceMember.deleteMany({
      where: { workspaceId: PLUS.workspaceId, userId: { in: [PLUS.memberId, PLUS.viewerId] } },
    });
    await db.workspaceInvitation.create({
      data: {
        workspaceId: PLUS.workspaceId,
        email: "stale@invite.test",
        role: "member",
        invitedById: PLUS.ownerId,
        scopeMode: "workspace",
        scope: "[]",
        tokenHash: "hash-stale",
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });

    const usage = await seatUsage(PLUS.workspaceId);
    assert.equal(usage.pending, 0, "an expired invitation is not pending and holds no seat");
  });

  test("a revoked invitation stops holding a seat", async () => {
    await db.workspaceMember.deleteMany({
      where: { workspaceId: PLUS.workspaceId, userId: { in: [PLUS.memberId, PLUS.viewerId] } },
    });
    await db.workspaceInvitation.create({
      data: {
        workspaceId: PLUS.workspaceId,
        email: "revoked@invite.test",
        role: "member",
        invitedById: PLUS.ownerId,
        scopeMode: "workspace",
        scope: "[]",
        tokenHash: "hash-revoked",
        expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        revokedAt: new Date(),
        revokedById: PLUS.ownerId,
      },
    });

    const usage = await seatUsage(PLUS.workspaceId);
    assert.equal(usage.pending, 0, "revoking frees the seat it was holding");
  });

  test("a legacy plan keeps the seat count it was sold with", async () => {
    const legacy = await createTenant("SeatsLegacy", { plan: "legacy_pro" });
    try {
      const usage = await seatUsage(legacy.workspaceId);
      assert.equal(
        usage.limit,
        PLANS.legacy_pro.limits.seats,
        "a legacy plan's entitlements are preserved, not remapped to a current tier",
      );
    } finally {
      await cleanupTenants([legacy]);
    }
  });

  test("the owner's plan governs, not the plan of whoever is inviting", async () => {
    // The member in the Free workspace could be on any plan; the ceiling is the
    // owner's either way. Put the member on Pro to make the point concrete.
    await db.user.update({ where: { id: FREE.memberId }, data: { plan: "pro" } });
    try {
      const usage = await seatUsage(FREE.workspaceId);
      assert.equal(usage.limit, PLANS.free.limits.seats, "still the owner's ceiling");
      assert.equal(usage.ownerPlan, "free");
    } finally {
      await db.user.update({ where: { id: FREE.memberId }, data: { plan: "free" } });
    }
  });
});
