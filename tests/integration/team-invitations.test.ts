import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import type { Role } from "../../src/lib/auth/permissions";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { hashInvitationToken } from "../../src/lib/auth/invitations";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * The invitation lifecycle, end to end.
 *
 * Every case here is one a real team will hit, and several are the ones an
 * attacker hits: a forwarded link, a stale link, a link redeemed by the wrong
 * account. The suite pairs each refusal with the matching success, so a broken
 * implementation that refuses everything cannot pass by refusing everything.
 *
 * The token never leaves the server in normal operation, so these tests read it
 * the only other way it exists — by issuing one directly and hashing it — and
 * assert against the row. Nothing here inspects an email body.
 */

let A: Tenant;
let B: Tenant;
/** Accounts created per test, cleaned up afterwards. */
let strays: string[] = [];

async function newAccount(email: string, options: { verified?: boolean } = {}) {
  const user = await db.user.create({
    data: {
      email: email.toLowerCase(),
      name: email.split("@")[0] ?? "Tester",
      passwordHash: await bcrypt.hash("correct-horse-battery", 4),
      emailVerifiedAt: options.verified === false ? null : new Date(),
    },
    select: { id: true },
  });
  strays.push(user.id);
  return user.id;
}

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@invite.test`.toLowerCase();
}

describe("workspace invitations", () => {
  before(async () => {
    A = await createTenant("InviteAlpha");
    B = await createTenant("InviteBeta");
  });

  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  beforeEach(async () => {
    strays = [];
    // The mutation limiter is right for a person and wrong for a suite that
    // invites in every test. Cleared through the limiter's own reset rather
    // than by loosening the policy.
    for (const id of [A.ownerId, B.ownerId, A.memberId, A.workspaceId, B.workspaceId]) {
      await resetRateLimit("mutation", { user: id, workspace: id, global: id });
    }
  });

  const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

  async function invite(email: string, role: Role = "member", workspace = A) {
    const { inviteTeamMember } = await import("../../src/lib/actions/team");
    return runAsTestIdentity(workspace.ownerId, () =>
      inviteTeamMember({ workspaceId: workspace.workspaceId, email, role }),
    );
  }

  /** The plaintext token for the newest live invitation to an address. */
  async function tokenFor(email: string): Promise<string> {
    // Issued directly so the plaintext is in hand; the action's own path is
    // exercised by the tests that call `invite()`.
    const { issueInvitation } = await import("../../src/lib/auth/invitations");
    const issued = await issueInvitation({
      workspaceId: A.workspaceId,
      email,
      role: "member",
      invitedById: A.ownerId,
    });
    return issued.token;
  }

  async function accept(token: string, userId: string) {
    const { acceptInvitation } = await import("../../src/lib/actions/team");
    await resetRateLimit("mutation", { user: userId, workspace: userId, global: userId });
    return runAsTestIdentity(userId, () => acceptInvitation(token));
  }

  // -------------------------------------------------------------------------
  describe("issuing", () => {
    test("an owner can invite, and the row carries scope from the first migration", async () => {
      const email = uniqueEmail("new");
      const result = await invite(email, "member");
      assert.equal(result.ok, true, `invite failed: ${JSON.stringify(result)}`);

      const row = await db.workspaceInvitation.findFirst({
        where: { workspaceId: A.workspaceId, email },
        select: { role: true, scopeMode: true, scope: true, tokenHash: true, acceptedAt: true },
      });
      assert.ok(row, "no invitation was written");
      assert.equal(row.role, "member");
      // Team-2 must not need a data migration of anything already pending.
      assert.equal(row.scopeMode, "workspace");
      assert.deepEqual(JSON.parse(row.scope), []);
      assert.equal(row.acceptedAt, null);
    });

    test("only the hash is stored — the token is not recoverable from the row", async () => {
      const email = uniqueEmail("hash");
      const token = await tokenFor(email);
      const row = await db.workspaceInvitation.findFirst({
        where: { email },
        select: { tokenHash: true },
      });
      assert.ok(row);
      assert.equal(row.tokenHash, hashInvitationToken(token));
      assert.notEqual(row.tokenHash, token, "the plaintext token was stored");
      assert.ok(token.length >= 40, "the token is too short to be 32 random bytes");
    });

    test("a member cannot invite anyone", async () => {
      const { inviteTeamMember } = await import("../../src/lib/actions/team");
      const result = await runAsTestIdentity(A.memberId, () =>
        inviteTeamMember({ workspaceId: A.workspaceId, email: uniqueEmail("nope"), role: "member" }),
      );
      assert.equal(result.ok, false, "a member issued an invitation");
    });

    test("an admin cannot invite an owner", async () => {
      // Rank, not role name: the rule that stops an admin minting an owner by
      // changing a role has to stop them minting one by invitation too.
      await db.workspaceMember.updateMany({
        where: { workspaceId: A.workspaceId, userId: A.memberId },
        data: { role: "admin" },
      });
      try {
        const { inviteTeamMember } = await import("../../src/lib/actions/team");
        const asOwnerRole = await runAsTestIdentity(A.memberId, () =>
          inviteTeamMember({ workspaceId: A.workspaceId, email: uniqueEmail("esc"), role: "owner" }),
        );
        assert.equal(asOwnerRole.ok, false, "an admin invited an owner");

        await resetRateLimit("mutation", { user: A.memberId, workspace: A.workspaceId, global: A.memberId });
        const asMemberRole = await runAsTestIdentity(A.memberId, () =>
          inviteTeamMember({ workspaceId: A.workspaceId, email: uniqueEmail("ok"), role: "member" }),
        );
        assert.equal(asMemberRole.ok, true, "an admin could not invite a member");
      } finally {
        await db.workspaceMember.updateMany({
          where: { workspaceId: A.workspaceId, userId: A.memberId },
          data: { role: "member" },
        });
      }
    });

    test("inviting someone already in the workspace is refused", async () => {
      const owner = await db.user.findUnique({
        where: { id: A.ownerId },
        select: { email: true },
      });
      const result = await invite(owner!.email, "member");
      assert.equal(result.ok, false, "an existing member was re-invited");
    });

    test("a duplicate invitation supersedes the first rather than stacking", async () => {
      const email = uniqueEmail("dupe");
      const first = await tokenFor(email);
      const second = await tokenFor(email);

      const live = await db.workspaceInvitation.count({
        where: { workspaceId: A.workspaceId, email, acceptedAt: null, revokedAt: null },
      });
      assert.equal(live, 1, "two live invitations exist for one address");

      // And the earlier link is dead, not merely superseded in the listing.
      const userId = await newAccount(email);
      const stale = await accept(first, userId);
      assert.equal(stale.ok, false, "a superseded invitation was still redeemable");

      const fresh = await accept(second, userId);
      assert.equal(fresh.ok, true, `the replacement failed: ${JSON.stringify(fresh)}`);
    });
  });

  // -------------------------------------------------------------------------
  describe("accepting", () => {
    test("a brand-new account joins the existing workspace", async () => {
      const email = uniqueEmail("brand-new");
      const token = await tokenFor(email);
      const userId = await newAccount(email);

      const before = await db.workspaceMember.count({ where: { userId } });
      assert.equal(before, 0, "the fixture account already had a membership");

      const result = await accept(token, userId);
      assert.equal(result.ok, true, `accept failed: ${JSON.stringify(result)}`);

      const memberships = await db.workspaceMember.findMany({
        where: { userId },
        select: { workspaceId: true, role: true },
      });
      assert.equal(memberships.length, 1, "the account did not join exactly one workspace");
      assert.equal(memberships[0]!.workspaceId, A.workspaceId);
      assert.equal(memberships[0]!.role, "member");
    });

    test("accepting never creates a second workspace", async () => {
      // The defect this guards: the app layout redirects to /welcome while an
      // account has no workspace, and completing onboarding provisions one. An
      // invited person who reached that first would be handed a workspace of
      // their own and land in an empty CRM.
      const email = uniqueEmail("no-second");
      const token = await tokenFor(email);
      const userId = await newAccount(email);

      const workspacesBefore = await db.workspace.count();
      const result = await accept(token, userId);
      assert.equal(result.ok, true);

      const workspacesAfter = await db.workspace.count();
      assert.equal(workspacesAfter, workspacesBefore, "a workspace was created by accepting");
      const owned = await db.workspace.count({ where: { ownerId: userId } });
      assert.equal(owned, 0, "the invitee was given a workspace of their own");
    });

    test("accepting marks the account onboarded, so setup is never offered again", async () => {
      const email = uniqueEmail("onboarded");
      const token = await tokenFor(email);
      const userId = await newAccount(email);
      const accepted = await accept(token, userId);
      assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);

      const user = await db.user.findUnique({
        where: { id: userId },
        select: { onboardedAt: true, emailVerifiedAt: true },
      });
      assert.ok(user?.onboardedAt, "the account would be sent back through onboarding");
      // The token was delivered to that inbox and spent once — the same
      // evidence a verification link provides.
      assert.ok(user?.emailVerifiedAt, "the address was not treated as confirmed");
    });

    test("an existing Tiny user joins without losing their own workspace", async () => {
      const email = uniqueEmail("existing");
      const userId = await newAccount(email);
      const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
      const own = await provisionWorkspace(userId, { name: "Their own business" });

      const token = await tokenFor(email);
      const result = await accept(token, userId);
      assert.equal(result.ok, true, `accept failed: ${JSON.stringify(result)}`);

      const memberships = await db.workspaceMember.findMany({
        where: { userId },
        select: { workspaceId: true },
      });
      const ids = memberships.map((m) => m.workspaceId).sort();
      assert.deepEqual(ids, [own.id, A.workspaceId].sort(), "the two memberships are not both present");
    });

    test("a second click does not join twice", async () => {
      const email = uniqueEmail("twice");
      const token = await tokenFor(email);
      const userId = await newAccount(email);

      assert.equal((await accept(token, userId)).ok, true);
      const again = await accept(token, userId);
      assert.equal(again.ok, false, "a spent invitation was redeemed a second time");

      const count = await db.workspaceMember.count({ where: { userId, workspaceId: A.workspaceId } });
      assert.equal(count, 1, "the account joined twice");
    });

    test("an expired invitation is refused", async () => {
      const email = uniqueEmail("expired");
      const token = await tokenFor(email);
      await db.workspaceInvitation.updateMany({
        where: { tokenHash: hashInvitationToken(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const userId = await newAccount(email);
      const result = await accept(token, userId);
      assert.equal(result.ok, false, "an expired invitation was accepted");
      assert.equal(await db.workspaceMember.count({ where: { userId } }), 0);
    });

    test("a revoked invitation is refused", async () => {
      const email = uniqueEmail("revoked");
      const token = await tokenFor(email);
      await db.workspaceInvitation.updateMany({
        where: { tokenHash: hashInvitationToken(token) },
        data: { revokedAt: new Date() },
      });

      const userId = await newAccount(email);
      const result = await accept(token, userId);
      assert.equal(result.ok, false, "a revoked invitation was accepted");
      assert.equal(await db.workspaceMember.count({ where: { userId } }), 0);
    });

    test("an unknown token is refused", async () => {
      const userId = await newAccount(uniqueEmail("unknown"));
      const result = await accept("not-a-real-token-at-all", userId);
      assert.equal(result.ok, false);
      assert.equal(await db.workspaceMember.count({ where: { userId } }), 0);
    });

    test("a different account cannot redeem someone else's invitation", async () => {
      // The forwarded-email case. The link is a bearer credential, so the
      // binding to one address is what stops it being a workspace-wide door.
      const invited = uniqueEmail("intended");
      const token = await tokenFor(invited);
      const wrongUser = await newAccount(uniqueEmail("interloper"));

      const result = await accept(token, wrongUser);
      assert.equal(result.ok, false, "a token was redeemed by the wrong account");
      assert.equal(await db.workspaceMember.count({ where: { userId: wrongUser } }), 0);

      // And the intended recipient can still use it — the refusal did not burn it.
      const rightUser = await newAccount(invited);
      assert.equal((await accept(token, rightUser)).ok, true, "the refusal consumed the token");
    });

    test("the address is matched case-insensitively", async () => {
      const email = uniqueEmail("MixedCase");
      const token = await tokenFor(email.toUpperCase());
      const userId = await newAccount(email.toLowerCase());
      const result = await accept(token, userId);
      assert.equal(result.ok, true, "case alone defeated a legitimate acceptance");
    });
  });

  // -------------------------------------------------------------------------
  describe("managing outstanding invitations", () => {
    test("revoking makes the outstanding link dead", async () => {
      const email = uniqueEmail("revoke-flow");
      const token = await tokenFor(email);
      const row = await db.workspaceInvitation.findFirstOrThrow({
        where: { tokenHash: hashInvitationToken(token) },
        select: { id: true },
      });

      const { revokeInvitation } = await import("../../src/lib/actions/team");
      const revoked = await asOwner(() =>
        revokeInvitation({ workspaceId: A.workspaceId, invitationId: row.id }),
      );
      assert.equal(revoked.ok, true, `revoke failed: ${JSON.stringify(revoked)}`);

      const userId = await newAccount(email);
      assert.equal((await accept(token, userId)).ok, false, "a revoked link still worked");
    });

    test("resending issues a new token and kills the old one", async () => {
      const email = uniqueEmail("resend");
      const first = await tokenFor(email);
      const row = await db.workspaceInvitation.findFirstOrThrow({
        where: { tokenHash: hashInvitationToken(first) },
        select: { id: true },
      });

      const { resendInvitation } = await import("../../src/lib/actions/team");
      const resent = await asOwner(() =>
        resendInvitation({ workspaceId: A.workspaceId, invitationId: row.id }),
      );
      assert.equal(resent.ok, true, `resend failed: ${JSON.stringify(resent)}`);

      const userId = await newAccount(email);
      assert.equal((await accept(first, userId)).ok, false, "the superseded link still worked");

      const live = await db.workspaceInvitation.findFirst({
        where: { workspaceId: A.workspaceId, email, acceptedAt: null, revokedAt: null },
        select: { tokenHash: true },
      });
      assert.ok(live, "resending left no live invitation");
      assert.notEqual(live.tokenHash, hashInvitationToken(first), "resend reused the same token");
    });

    test("an invitation from another workspace cannot be revoked", async () => {
      const email = uniqueEmail("cross-revoke");
      const { issueInvitation } = await import("../../src/lib/auth/invitations");
      const theirs = await issueInvitation({
        workspaceId: B.workspaceId,
        email,
        role: "member",
        invitedById: B.ownerId,
      });

      const { revokeInvitation } = await import("../../src/lib/actions/team");
      const result = await asOwner(() =>
        revokeInvitation({ workspaceId: A.workspaceId, invitationId: theirs.id }),
      );
      assert.equal(result.ok, false, "workspace A revoked workspace B's invitation");

      const still = await db.workspaceInvitation.findUnique({
        where: { id: theirs.id },
        select: { revokedAt: true },
      });
      assert.equal(still?.revokedAt, null, "the other tenant's invitation was modified");
    });

    test("an invitation to workspace B never grants access to workspace A", async () => {
      const email = uniqueEmail("cross-accept");
      const { issueInvitation } = await import("../../src/lib/auth/invitations");
      const theirs = await issueInvitation({
        workspaceId: B.workspaceId,
        email,
        role: "member",
        invitedById: B.ownerId,
      });

      const userId = await newAccount(email);
      const result = await accept(theirs.token, userId);
      assert.equal(result.ok, true, `accept failed: ${JSON.stringify(result)}`);

      const memberships = await db.workspaceMember.findMany({
        where: { userId },
        select: { workspaceId: true },
      });
      assert.deepEqual(
        memberships.map((m) => m.workspaceId),
        [B.workspaceId],
        "accepting B's invitation reached another workspace",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("not an account-enumeration oracle", () => {
    test("inviting a known and an unknown address are indistinguishable", async () => {
      // Whether an address already has a Tiny account is not the inviter's
      // business to learn, and a difference in outcome — or in wording — turns
      // this form into a membership checker for any domain.
      const unknown = uniqueEmail("never-seen");
      const known = uniqueEmail("has-account");
      await newAccount(known);

      const a = await invite(unknown, "member");
      const b = await invite(known, "member");

      assert.equal(a.ok, true, `inviting an unknown address failed: ${JSON.stringify(a)}`);
      assert.equal(b.ok, true, `inviting a known address failed: ${JSON.stringify(b)}`);
      assert.deepEqual(
        a.ok && b.ok ? { ...a.data, email: "" } : null,
        b.ok && a.ok ? { ...b.data, email: "" } : null,
        "the two outcomes differ in shape",
      );
    });

    test("the welcome screen shows only invitations addressed to the caller", async () => {
      const mine = uniqueEmail("mine");
      const theirs = uniqueEmail("theirs");
      await tokenFor(mine);
      await tokenFor(theirs);
      const userId = await newAccount(mine);

      const { pendingInvitationsFor } = await import("../../src/lib/auth/invitations");
      const rows = await pendingInvitationsFor({ id: userId, email: mine });
      assert.equal(rows.length, 1, "the wrong number of invitations was visible");
      assert.equal(rows[0]!.workspaceId, A.workspaceId);
      // The other address's invitation exists and is live; it simply is not
      // this person's to see. The signature takes an identity rather than a
      // bare address precisely so asking otherwise is not expressible.
      const otherLives = await db.workspaceInvitation.count({
        where: { email: theirs, acceptedAt: null, revokedAt: null },
      });
      assert.equal(otherLives, 1, "the control invitation was not created");
    });

    test("accepting by id still checks the address", async () => {
      // The welcome screen's path takes an id, not a token. If the id alone
      // were enough, any signed-in user could join any workspace by guessing
      // one — so the address comparison has to happen on this path too.
      const invited = uniqueEmail("by-id-intended");
      await tokenFor(invited);
      const invitation = await db.workspaceInvitation.findFirstOrThrow({
        where: { email: invited, acceptedAt: null, revokedAt: null },
        select: { id: true },
      });

      const interloper = await newAccount(uniqueEmail("by-id-interloper"));
      const { acceptInvitationById } = await import("../../src/lib/actions/team");
      await resetRateLimit("mutation", { user: interloper, workspace: interloper, global: interloper });
      const stolen = await runAsTestIdentity(interloper, () => acceptInvitationById(invitation.id));
      assert.equal(stolen.ok, false, "an invitation was accepted by id by the wrong account");
      assert.equal(await db.workspaceMember.count({ where: { userId: interloper } }), 0);

      // Paired with the success, so a blanket refusal cannot pass this.
      const rightful = await newAccount(invited);
      await resetRateLimit("mutation", { user: rightful, workspace: rightful, global: rightful });
      const joined = await runAsTestIdentity(rightful, () => acceptInvitationById(invitation.id));
      assert.equal(joined.ok, true, `the addressee could not accept: ${JSON.stringify(joined)}`);
    });
  });

  // -------------------------------------------------------------------------
  describe("owner safety", () => {
    test("the last owner cannot be demoted", async () => {
      const owners = await db.workspaceMember.count({
        where: { workspaceId: A.workspaceId, role: "owner" },
      });
      assert.equal(owners, 1, "the fixture no longer has exactly one owner");

      const { changeMemberRole } = await import("../../src/lib/actions/settings");
      const result = await asOwner(() =>
        changeMemberRole({ workspaceId: A.workspaceId, userId: A.ownerId, role: "admin" }),
      );
      assert.equal(result.ok, false, "the only owner demoted themselves");

      const still = await db.workspaceMember.findFirst({
        where: { workspaceId: A.workspaceId, userId: A.ownerId },
        select: { role: true },
      });
      assert.equal(still?.role, "owner");
    });

    test("the last owner cannot be removed", async () => {
      const { removeMember } = await import("../../src/lib/actions/settings");
      const result = await asOwner(() => removeMember(A.workspaceId, A.ownerId));
      assert.equal(result.ok, false, "the only owner was removed");
      assert.equal(
        await db.workspaceMember.count({ where: { workspaceId: A.workspaceId, userId: A.ownerId } }),
        1,
      );
    });

    test("with two owners, one may step down", async () => {
      // Paired with the two above on purpose: an implementation that refuses
      // every demotion would pass those and fail this.
      const email = uniqueEmail("second-owner");
      const { issueInvitation } = await import("../../src/lib/auth/invitations");
      const issued = await issueInvitation({
        workspaceId: A.workspaceId,
        email,
        role: "owner",
        invitedById: A.ownerId,
      });
      const second = await newAccount(email);
      assert.equal((await accept(issued.token, second)).ok, true);

      const { changeMemberRole } = await import("../../src/lib/actions/settings");
      const result = await asOwner(() =>
        changeMemberRole({ workspaceId: A.workspaceId, userId: second, role: "member" }),
      );
      assert.equal(result.ok, true, `a second owner could not be demoted: ${JSON.stringify(result)}`);

      await db.workspaceMember.deleteMany({ where: { workspaceId: A.workspaceId, userId: second } });
    });

    test("a member cannot promote themselves", async () => {
      const { changeMemberRole } = await import("../../src/lib/actions/settings");
      const result = await runAsTestIdentity(A.memberId, () =>
        changeMemberRole({ workspaceId: A.workspaceId, userId: A.memberId, role: "owner" }),
      );
      assert.equal(result.ok, false, "a member promoted themselves to owner");

      const still = await db.workspaceMember.findFirst({
        where: { workspaceId: A.workspaceId, userId: A.memberId },
        select: { role: true },
      });
      assert.equal(still?.role, "member");
    });

    test("removing a member removes their access immediately", async () => {
      const email = uniqueEmail("removed");
      const token = await tokenFor(email);
      const userId = await newAccount(email);
      assert.equal((await accept(token, userId)).ok, true);

      const { getMemberships } = await import("../../src/lib/auth/context");
      const before = await getMemberships(userId);
      assert.equal(before.length, 1, "the new member had no membership to lose");

      const { removeMember } = await import("../../src/lib/actions/settings");
      assert.equal((await asOwner(() => removeMember(A.workspaceId, userId))).ok, true);

      const after = await getMemberships(userId);
      assert.equal(after.length, 0, "access survived removal");
    });
  });

  after(async () => {
    if (strays.length > 0) {
      await db.workspaceMember.deleteMany({ where: { userId: { in: strays } } });
      await db.user.deleteMany({ where: { id: { in: strays } } });
    }
  });
});
