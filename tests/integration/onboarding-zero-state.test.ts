import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { db } from "../helpers/fixtures";

/**
 * Skipping setup must not be a trap.
 *
 * An external tester reported: *"not working for me when I skipped setup. Now
 * its a blank screen."* The account was left with `onboardedAt` set and no
 * workspace, and the two redirect guards then disagreed forever:
 *
 *   src/app/(app)/layout.tsx    no workspace -> redirect to /welcome
 *   src/app/(app)/welcome/page  no workspace -> render onboarding again
 *
 * Every app route bounced back to onboarding, and the moment of skipping
 * rendered an empty frame while that chain resolved. There was no exception, no
 * console error and no failed request, so nothing in the existing suite — or in
 * the error tracker — could have noticed.
 *
 * These tests assert the invariant that makes the dead end unreachable rather
 * than asserting the absence of a blank screen, which is unobservable from
 * here: **an account that has completed onboarding always has a workspace.**
 *
 * A note on what this does and does not cover. It exercises the server action
 * that "Skip setup" invokes, which is where the defect lived. It does not drive
 * the browser, so it cannot prove the rendered screen is non-blank; that was
 * verified against the deployed application by reproducing the tester's exact
 * path. Both halves are needed and neither substitutes for the other.
 */

const created: string[] = [];

async function freshAccount(name: string): Promise<string> {
  const id = `c${randomUUID().replace(/-/g, "")}`;
  await db.user.create({
    data: {
      id,
      email: `zero-state-${id}@test.local`,
      name,
      passwordHash: await bcrypt.hash("correct-horse-battery", 4),
      emailVerifiedAt: new Date(),
    },
  });
  created.push(id);
  return id;
}

describe("an account that skipped setup can still use the application", () => {
  after(async () => {
    for (const id of created) {
      const memberships = await db.workspaceMember.findMany({ where: { userId: id }, select: { workspaceId: true } });
      await db.workspace.deleteMany({ where: { id: { in: memberships.map((m) => m.workspaceId) } } });
      await db.user.deleteMany({ where: { id } });
    }
    await db.$disconnect();
  });

  test("completing onboarding with nothing set up leaves a usable workspace", async () => {
    const userId = await freshAccount("Sam Okafor");
    const before = await db.workspaceMember.count({ where: { userId } });
    assert.equal(before, 0, "the fixture should start with no workspace");

    const { completeOnboarding } = await import("../../src/lib/actions/onboarding");
    const result = await runAsTestIdentity(userId, () => completeOnboarding());
    assert.equal(result.ok, true, `skipping setup failed: ${JSON.stringify(result)}`);

    const memberships = await db.workspaceMember.count({ where: { userId } });
    assert.equal(
      memberships,
      1,
      "skipping setup left the account with no workspace — every app route will redirect to /welcome forever",
    );
  });

  test("the account is marked onboarded, so /welcome steps aside", async () => {
    const userId = await freshAccount("Dana Whitfield");
    const { completeOnboarding } = await import("../../src/lib/actions/onboarding");
    await runAsTestIdentity(userId, () => completeOnboarding());

    const user = await db.user.findUnique({ where: { id: userId }, select: { onboardedAt: true } });
    assert.ok(user?.onboardedAt, "onboardedAt was not set");
  });

  test("the invariant both redirect guards depend on: onboarded implies a workspace", async () => {
    // This is the property. The layout sends an account with no workspace to
    // /welcome; /welcome only steps aside once one exists. If completing
    // onboarding can ever leave zero workspaces, those two guards form a loop.
    const userId = await freshAccount("Marcus Reeve");
    const { completeOnboarding } = await import("../../src/lib/actions/onboarding");
    await runAsTestIdentity(userId, () => completeOnboarding());

    const user = await db.user.findUnique({ where: { id: userId }, select: { onboardedAt: true } });
    const memberships = await db.workspaceMember.count({ where: { userId } });
    if (user?.onboardedAt) {
      assert.ok(memberships >= 1, "an onboarded account with no workspace cannot reach any screen");
    }
  });

  test("skipping twice does not create a second workspace", async () => {
    // `finish()` is bound to both "Skip setup" and the final step. A
    // double-submit must not hand a customer two workspaces on a plan that
    // allows one.
    const userId = await freshAccount("Priya Raman");
    const { completeOnboarding } = await import("../../src/lib/actions/onboarding");
    await runAsTestIdentity(userId, () => completeOnboarding());
    await runAsTestIdentity(userId, () => completeOnboarding());

    const memberships = await db.workspaceMember.count({ where: { userId } });
    assert.equal(memberships, 1, `a repeated skip created ${memberships} workspaces`);
  });

  test("the workspace it creates is named after the person, not left blank", async () => {
    const userId = await freshAccount("Sam Okafor");
    const { completeOnboarding } = await import("../../src/lib/actions/onboarding");
    await runAsTestIdentity(userId, () => completeOnboarding());

    const membership = await db.workspaceMember.findFirst({
      where: { userId },
      select: { workspace: { select: { name: true } } },
    });
    assert.match(String(membership?.workspace.name), /Sam/, "the default workspace has no recognisable name");
  });

  test("creating the first workspace is actually recorded in the audit log", async () => {
    // This is the assertion that would have caught a defect nobody saw for the
    // life of the deployment. Production had three workspaces and zero
    // `workspace.created` rows: the audit was written from the caller's
    // context, which cannot contain a workspace that did not exist when that
    // context was built, so PostgreSQL refused every one of them and the
    // swallowed failure aborted the surrounding transaction.
    //
    // It only fails on PostgreSQL. SQLite has no row-level security, so the
    // write succeeds there and this test passes for the wrong reason — which is
    // precisely why the suite runs against both.
    const userId = await freshAccount("Nadia Farr");
    const { completeOnboarding } = await import("../../src/lib/actions/onboarding");
    const result = await runAsTestIdentity(userId, () => completeOnboarding());
    assert.equal(result.ok, true, `skipping setup failed: ${JSON.stringify(result)}`);

    const entries = await db.auditLog.findMany({
      where: { actorId: userId, action: "workspace.created" },
      select: { workspaceId: true, summary: true },
    });
    assert.equal(entries.length, 1, `expected one workspace.created audit row, got ${entries.length}`);
    assert.ok(entries[0]!.workspaceId, "the audit row is not attached to the workspace it describes");
  });
});
