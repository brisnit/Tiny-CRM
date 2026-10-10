import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { suspendAccount, grantComplimentaryPlan } from "../../src/lib/actions/admin";
import { isPostgres } from "../../src/lib/env";

/**
 * The mutation and its record are one transaction, proven by breaking one.
 *
 * Asserting that a failed audit write returns an error is not the same claim.
 * The claim is that **the change does not survive** it: an entitlement moved,
 * or an account suspended, with no record of who did it or why is precisely
 * what the `required` flag exists to prevent, and the only way to know it
 * works is to make the audit write fail and then look at the row.
 *
 * This matters because the default is the opposite. `recordAudit` is
 * best-effort by design — an audit failure must never be why somebody cannot
 * sign in — so these four actions opt in, and an opt-in that was silently
 * dropped would look exactly like success.
 */

let admin: Tenant;
let target: Tenant;

before(async () => {
  admin = await createTenant("AtomicAdmin", { plan: "free" });
  target = await createTenant("AtomicTarget", { plan: "free" });
  await observer.platformAdmin.create({ data: { userId: admin.ownerId } });
});

after(async () => {
  await observer.platformAdmin.deleteMany({ where: { userId: admin.ownerId } });
  await observer.planGrant.deleteMany({ where: { userId: target.ownerId } });
  await cleanupTenants([admin, target]);
  await observer.$disconnect();
});

/**
 * Makes the audit insert fail for real, at the database.
 *
 * A first version of this patched the `recordAudit` export and proved nothing:
 * `audit()` binds the import at module load, so replacing the property on the
 * module object leaves the already-bound reference untouched and every
 * operation committed exactly as before — a green test asserting a mechanism
 * that was never exercised.
 *
 * A trigger that aborts the INSERT is the honest version. It fails inside the
 * same transaction the mutation runs in, by the same means a real outage would
 * — a constraint, a full disk, a revoked grant — rather than by arranging for
 * a function to throw.
 */
async function withFailingAudit<T>(fn: () => Promise<T>): Promise<T> {
  // Installed by the **observer**, not the application client: `tinycrm_app`
  // has no rights to create functions or triggers in `public`, which is
  // exactly the restriction being relied on everywhere else. Using the app
  // role here failed with "permission denied for schema public" and left the
  // audit sink working, so the actions committed and the test failed for the
  // wrong reason.
  if (isPostgres) {
    await observer.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION tc_test_block_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit sink unavailable'; END; $$;
    `);
    await observer.$executeRawUnsafe(`
      CREATE TRIGGER tc_test_block_audit BEFORE INSERT ON "AuditLog"
        FOR EACH ROW EXECUTE FUNCTION tc_test_block_audit();
    `);
  } else {
    await observer.$executeRawUnsafe(`
      CREATE TRIGGER tc_test_block_audit BEFORE INSERT ON "AuditLog"
      BEGIN SELECT RAISE(ABORT, 'audit sink unavailable'); END;
    `);
  }
  try {
    return await fn();
  } finally {
    await observer.$executeRawUnsafe(`DROP TRIGGER IF EXISTS tc_test_block_audit ON "AuditLog"`)
      .catch(async () => {
        await observer.$executeRawUnsafe(`DROP TRIGGER IF EXISTS tc_test_block_audit`);
      });
  }
}

describe("a failed audit write takes the mutation with it", () => {
  test("suspension does not survive an audit failure", async () => {
    const before = await observer.user.findUniqueOrThrow({
      where: { id: target.ownerId },
      select: { deactivatedAt: true, deactivatedReason: true, sessionEpoch: true },
    });
    assert.equal(before.deactivatedAt, null, "the fixture was already suspended");

    const result = await withFailingAudit(() =>
      runAsTestIdentity(admin.ownerId, () =>
        suspendAccount({ userId: target.ownerId, reason: "should roll back" }),
      ),
    );
    assert.equal(result.ok, false, "the action reported success with no audit entry");

    // The claim. Not "an error came back" — the account is untouched.
    const after = await observer.user.findUniqueOrThrow({
      where: { id: target.ownerId },
      select: { deactivatedAt: true, deactivatedReason: true, sessionEpoch: true },
    });
    assert.equal(after.deactivatedAt, null, "the account stayed suspended with no record of why");
    assert.equal(after.deactivatedReason, null);
    assert.equal(
      after.sessionEpoch,
      before.sessionEpoch,
      "sessions were invalidated by an operation that rolled back",
    );
  });

  test("a grant does not survive an audit failure", async () => {
    const result = await withFailingAudit(() =>
      runAsTestIdentity(admin.ownerId, () =>
        grantComplimentaryPlan({
          userId: target.ownerId, plan: "pro", reason: "should roll back",
        }),
      ),
    );
    assert.equal(result.ok, false, "the action reported success with no audit entry");

    assert.equal(
      await observer.planGrant.count({ where: { userId: target.ownerId } }),
      0,
      "an entitlement was granted with no record of who granted it",
    );
  });

  test("a superseding grant does not half-apply", async () => {
    // The revoke-and-replace path writes twice. If only the transaction's
    // later half rolled back, the customer would silently lose the access they
    // already had — worse than the operation failing.
    const first = await runAsTestIdentity(admin.ownerId, () =>
      grantComplimentaryPlan({ userId: target.ownerId, plan: "plus", reason: "original" }),
    );
    assert.equal(first.ok, true, `setup grant failed: ${first.ok ? "" : first.error}`);

    const result = await withFailingAudit(() =>
      runAsTestIdentity(admin.ownerId, () =>
        grantComplimentaryPlan({ userId: target.ownerId, plan: "pro", reason: "should roll back" }),
      ),
    );
    assert.equal(result.ok, false);

    const live = await observer.planGrant.findMany({
      where: { userId: target.ownerId, revokedAt: null },
      select: { plan: true, reason: true },
    });
    assert.equal(live.length, 1, "the superseding write left the grants in a half-applied state");
    assert.equal(live[0]!.plan, "plus", "the original grant was revoked by an operation that failed");
    assert.equal(live[0]!.reason, "original");
  });

  test("with the audit sink working, the same operations do commit", async () => {
    // The control. Without it, a test that asserts "nothing happened" passes
    // just as well when the action never worked at all.
    const ok = await runAsTestIdentity(admin.ownerId, () =>
      suspendAccount({ userId: target.ownerId, reason: "control" }),
    );
    assert.equal(ok.ok, true, `suspend failed: ${ok.ok ? "" : ok.error}`);
    const after = await observer.user.findUniqueOrThrow({
      where: { id: target.ownerId }, select: { deactivatedAt: true },
    });
    assert.ok(after.deactivatedAt, "the control did not commit");
  });
});
