import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import {
  grantComplimentaryPlan,
  revokeComplimentaryPlan,
  suspendAccount,
  reinstateAccount,
} from "../../src/lib/actions/admin";

/**
 * Who may operate the owner-admin panel, and what happens to everyone else.
 *
 * The panel reads and writes other people's accounts, so the interesting
 * assertions here are the refusals. Every one of them goes through the real
 * server action rather than a helper, because a server action is reachable by
 * POST whether or not a page ever rendered — testing a wrapper would prove
 * something about the wrapper.
 */

let admin: Tenant;
let ordinary: Tenant;
let victim: Tenant;

before(async () => {
  admin = await createTenant("AdminOwner", { plan: "free" });
  ordinary = await createTenant("OrdinaryUser", { plan: "free" });
  victim = await createTenant("TargetUser", { plan: "free" });
  await db.platformAdmin.create({ data: { userId: admin.ownerId, note: "test owner" } });
});

after(async () => {
  await db.platformAdmin.deleteMany({ where: { userId: { in: [admin.ownerId, ordinary.ownerId] } } });
  await db.planGrant.deleteMany({
    where: { userId: { in: [admin.ownerId, ordinary.ownerId, victim.ownerId] } },
  });
  await cleanupTenants([admin, ordinary, victim]);
  await db.$disconnect();
});

const asAdmin = <T>(fn: () => Promise<T>) => runAsTestIdentity(admin.ownerId, fn);
const asOrdinary = <T>(fn: () => Promise<T>) => runAsTestIdentity(ordinary.ownerId, fn);

describe("an ordinary user cannot reach administration", () => {
  test("every admin action refuses, and says nothing about why", async () => {
    const attempts: [string, () => Promise<{ ok: boolean; error?: string }>][] = [
      ["grant", () => asOrdinary(() => grantComplimentaryPlan({
        userId: victim.ownerId, plan: "pro", reason: "I would like this",
      }))],
      ["revoke", () => asOrdinary(() => revokeComplimentaryPlan({
        userId: victim.ownerId, reason: "I would like this",
      }))],
      ["suspend", () => asOrdinary(() => suspendAccount({
        userId: victim.ownerId, reason: "I would like this",
      }))],
      ["reinstate", () => asOrdinary(() => reinstateAccount({
        userId: victim.ownerId, reason: "I would like this",
      }))],
    ];

    for (const [name, run] of attempts) {
      const result = await run();
      assert.equal(result.ok, false, `${name} was allowed for a non-admin`);
      // "Not found", never "forbidden": confirming the surface exists is a
      // disclosure to somebody who should not know it does.
      assert.match(result.error ?? "", /not found/i, `${name} disclosed that admin exists`);
      assert.doesNotMatch(result.error ?? "", /admin|platform|permission/i);
    }
  });

  test("nothing happened to the target account", async () => {
    const target = await db.user.findUniqueOrThrow({
      where: { id: victim.ownerId },
      select: { deactivatedAt: true, plan: true },
    });
    assert.equal(target.deactivatedAt, null, "a non-admin suspended an account");
    assert.equal(target.plan, "free", "a non-admin changed a stored plan");
    assert.equal(
      await db.planGrant.count({ where: { userId: victim.ownerId } }),
      0,
      "a non-admin created a grant",
    );
  });

  test("a user cannot make themselves an admin through any action here", async () => {
    // There is no action that writes PlatformAdmin — that is the point. This
    // asserts the absence stays an absence: the module exports no such thing,
    // so a future one has to be added deliberately rather than appear.
    const actions = await import("../../src/lib/actions/admin");
    const names = Object.keys(actions);
    for (const name of names) {
      assert.doesNotMatch(
        name,
        /platformAdmin|makeAdmin|grantAdmin|addAdmin/i,
        `${name} looks like a path to self-granting administration`,
      );
    }
    assert.equal(
      await db.platformAdmin.count({ where: { userId: ordinary.ownerId } }),
      0,
      "an ordinary user holds administration",
    );
  });

  test("being signed out refuses too, rather than falling open", async () => {
    const result = await grantComplimentaryPlan({
      userId: victim.ownerId, plan: "pro", reason: "no session at all",
    });
    assert.equal(result.ok, false, "an unauthenticated call was allowed");
  });
});

describe("the admin cannot disarm themselves", () => {
  test("self-suspension is refused", async () => {
    const result = await asAdmin(() => suspendAccount({
      userId: admin.ownerId, reason: "testing the guard",
    }));
    assert.equal(result.ok, false, "the admin suspended their own account");
    assert.match(result.error ?? "", /your own account/i);

    const self = await db.user.findUniqueOrThrow({
      where: { id: admin.ownerId }, select: { deactivatedAt: true },
    });
    assert.equal(self.deactivatedAt, null, "the admin's own account was suspended");
  });
});

describe("the admin may act on other accounts", () => {
  test("suspend, then reinstate, both recorded", async () => {
    const suspended = await asAdmin(() => suspendAccount({
      userId: victim.ownerId, reason: "payment dispute pending",
    }));
    assert.equal(suspended.ok, true, `suspend failed: ${suspended.ok ? "" : suspended.error}`);

    let target = await db.user.findUniqueOrThrow({
      where: { id: victim.ownerId },
      select: { deactivatedAt: true, deactivatedReason: true, sessionEpoch: true },
    });
    assert.ok(target.deactivatedAt, "the account was not suspended");
    assert.equal(target.deactivatedReason, "payment dispute pending");
    assert.ok(target.sessionEpoch > 0, "existing sessions were not invalidated");

    const reinstated = await asAdmin(() => reinstateAccount({
      userId: victim.ownerId, reason: "dispute resolved",
    }));
    assert.equal(reinstated.ok, true);

    target = await db.user.findUniqueOrThrow({
      where: { id: victim.ownerId },
      select: { deactivatedAt: true, deactivatedReason: true, sessionEpoch: true },
    });
    assert.equal(target.deactivatedAt, null, "the account was not reinstated");
    assert.equal(target.deactivatedReason, null, "the suspension reason outlived the suspension");
  });

  test("a suspended account loses its session immediately, not at next sign-in", async () => {
    await asAdmin(() => suspendAccount({ userId: victim.ownerId, reason: "session check" }));
    try {
      // `getIdentity` re-reads the row every request, so an actor resolved
      // while suspended is null even holding a structurally valid session.
      const { getActor } = await import("../../src/lib/auth/access");
      const actor = await runAsTestIdentity(victim.ownerId, () => getActor());
      assert.equal(actor, null, "a suspended account still resolved to an actor");
    } finally {
      await asAdmin(() => reinstateAccount({ userId: victim.ownerId, reason: "cleanup" }));
    }
  });
});
