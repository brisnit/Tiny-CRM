import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcryptjs";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { withTenantContext } from "../../src/lib/tenant-db";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { isPostgres } from "../../src/lib/env";

/**
 * Turning restriction on: activation, materialization, and the lifecycle after.
 *
 * Steps 3A and 3B built the boundary and proved it holds. Nobody stands behind
 * it: every membership in production is `workspace` and RecordGrant is empty.
 * This file is about the machinery that would put someone there — issuing a
 * restricted invitation, materializing its anchors into grants, moving a
 * membership between scopes, and taking access away again — and about what the
 * system does today when asked to do those things.
 *
 * Written red, first, on purpose. A test that passes here is a property the
 * system already has and must not lose; a test that fails is the work of the
 * green phase, named precisely enough that its fix is not a guess.
 *
 * ACTOR    `db` — the application's client, `tinycrm_app`, NOBYPASSRLS. Every
 *          operation under test runs through it or through a server action.
 * OBSERVER `observer` — privileged. Builds the world and reads ground truth.
 *          It never performs the operation under test.
 *
 * The invitation path is exercised for real: `issueInvitation` is the library
 * function the server action calls, and it already accepts a scope payload, so
 * a restricted invitation can be issued the way a UI eventually will. The
 * acceptance is the real server action, unmodified.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;
let B: Tenant;

const id = {
  /** Anchors in A, named for how they are meant to be reached. */
  offeredOpp: "",
  offeredProject: "",
  withheldOpp: "",
  /** An anchor in the *other* workspace, for injection attempts. */
  foreignOpp: "",
  /** A contact reachable only through the offered opportunity. */
  offeredContact: "",
  withheldContact: "",
  /** A deal on the offered project — restricted members never see deals. */
  dealOnOfferedProject: "",
};

let invitee = { id: "", email: "" };
let secondInvitee = { id: "", email: "" };

// ---------------------------------------------------------------------------
// Helpers — real paths wherever one exists
// ---------------------------------------------------------------------------

type ScopeEntry = { entityType: "opportunity" | "project"; entityId: string };

/**
 * Issues an invitation carrying a scope payload, through the library function
 * the server action uses. Returns the plaintext token.
 */
async function issueRestricted(options: {
  email: string;
  scope: ScopeEntry[];
  workspace?: Tenant;
  scopeMode?: "workspace" | "restricted";
  role?: string;
}): Promise<string> {
  const { issueInvitation } = await import("../../src/lib/auth/invitations");
  const ws = options.workspace ?? A;
  const issued = await issueInvitation({
    workspaceId: ws.workspaceId,
    email: options.email,
    role: (options.role ?? "member") as "member",
    invitedById: ws.ownerId,
    scopeMode: options.scopeMode ?? "restricted",
    scope: options.scope,
  });
  return issued.token;
}

/** Accepts through the real server action, as the invited person. */
async function accept(token: string, userId: string) {
  const { acceptInvitation } = await import("../../src/lib/actions/team");
  await resetRateLimit("mutation", { user: userId, workspace: userId, global: userId });
  return runAsTestIdentity(userId, () => acceptInvitation(token));
}

/** Reads as a restricted member, declaring restriction the way the request path does. */
function asRestricted<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withTenantContext(
    { workspaceIds: [A.workspaceId], userId, restrictedWorkspaceIds: [A.workspaceId] },
    fn,
  );
}

/** Ground truth: the grants that exist for one person, by anchor. */
async function grantsFor(userId: string): Promise<string[]> {
  const rows = await observer.recordGrant.findMany({
    where: { workspaceId: A.workspaceId, userId },
    select: { anchorType: true, anchorId: true },
    orderBy: { anchorId: "asc" },
  });
  return rows.map((r) => `${r.anchorType}:${r.anchorId}`).sort();
}

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@activation.invalid`;
  const user = await observer.user.create({
    data: {
      email,
      name: label,
      passwordHash: await bcrypt.hash("correct-horse-battery", 4),
      emailVerifiedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  return user;
}

before(async () => {
  A = await createTenant("ActivateAlpha");
  B = await createTenant("ActivateBeta");

  const ws = A.workspaceId;
  id.offeredOpp = (
    await observer.opportunity.create({
      data: { workspaceId: ws, name: "Harbour redevelopment" },
      select: { id: true },
    })
  ).id;
  id.withheldOpp = (
    await observer.opportunity.create({
      data: { workspaceId: ws, name: "Meridian bid" },
      select: { id: true },
    })
  ).id;
  id.offeredProject = (
    await observer.project.create({
      data: { workspaceId: ws, name: "Harbour delivery", statusId: A.statusId },
      select: { id: true },
    })
  ).id;
  id.foreignOpp = (
    await observer.opportunity.create({
      data: { workspaceId: B.workspaceId, name: "Someone else's pursuit" },
      select: { id: true },
    })
  ).id;

  const contact = async (first: string) =>
    (
      await observer.contact.create({
        data: {
          workspaceId: ws,
          firstName: first,
          lastName: "Vance",
          fullName: `${first} Vance`,
          email: `${first.toLowerCase()}@activation.invalid`,
        },
        select: { id: true },
      })
    ).id;
  id.offeredContact = await contact("Ines");
  id.withheldContact = await contact("Ruth");
  await observer.opportunityContact.create({
    data: { opportunityId: id.offeredOpp, contactId: id.offeredContact },
  });
  await observer.opportunityContact.create({
    data: { opportunityId: id.withheldOpp, contactId: id.withheldContact },
  });

  id.dealOnOfferedProject = (
    await observer.deal.create({
      data: {
        workspaceId: ws,
        name: "Harbour phase two",
        pipelineId: A.pipelineId,
        stageId: A.stageId,
        projectId: id.offeredProject,
      },
      select: { id: true },
    })
  ).id;

  invitee = await makeUser("invitee");
  secondInvitee = await makeUser("second");
});

beforeEach(async () => {
  for (const user of [A.ownerId, A.memberId, A.viewerId, invitee.id, secondInvitee.id, B.ownerId]) {
    await resetRateLimit("mutation", { user, workspace: A.workspaceId, global: user });
    await resetRateLimit("mutation", { user, workspace: user, global: user });
  }
});

after(async () => {
  await observer.recordGrant.deleteMany({ where: { workspaceId: A.workspaceId } });
  await cleanupTenants([A, B]);
  await observer.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Issuing a restricted invitation
// ---------------------------------------------------------------------------

describe("issuing a restricted invitation", () => {
  test("an administrator can invite somebody to particular work", pgOnly ?? {}, async () => {
    const { inviteTeamMember } = await import("../../src/lib/actions/team");
    const email = `gap-${Date.now().toString(36)}@activation.invalid`;
    const result = await runAsTestIdentity(A.ownerId, () =>
      inviteTeamMember({
        workspaceId: A.workspaceId,
        email,
        role: "member",
        scopeMode: "restricted",
        scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
      }),
    );

    assert.equal(result.ok, true, `the invitation was refused: ${JSON.stringify(result)}`);
    const row = await observer.workspaceInvitation.findFirst({
      where: { workspaceId: A.workspaceId, email },
      select: { scopeMode: true, scope: true },
    });
    assert.ok(row, "no invitation row was written");
    assert.equal(
      row.scopeMode,
      "restricted",
      "the action silently discarded the requested scope mode — there is no way to invite " +
        "somebody to particular work",
    );
    assert.deepEqual(
      JSON.parse(row.scope),
      [{ entityType: "opportunity", entityId: id.offeredOpp }],
      "the action silently discarded the requested anchors",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Materializing grants at acceptance
// ---------------------------------------------------------------------------

describe("accepting a restricted invitation materializes grants", () => {
  test("an opportunity in the scope payload becomes a grant", pgOnly ?? {}, async () => {
    const user = await makeUser("opp-grant");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
    });

    const result = await accept(token, user.id);
    assert.equal(result.ok, true, `acceptance failed: ${JSON.stringify(result)}`);

    const membership = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: user.id },
      select: { scopeMode: true },
    });
    assert.equal(membership?.scopeMode, "restricted", "the membership did not carry the scope mode");

    assert.deepEqual(
      await grantsFor(user.id),
      [`opportunity:${id.offeredOpp}`],
      "the invitation named an opportunity and no grant was created — the member joined " +
        "restricted with access to nothing",
    );
  });

  test("a project in the scope payload becomes a grant", pgOnly ?? {}, async () => {
    const user = await makeUser("proj-grant");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "project", entityId: id.offeredProject }],
    });

    assert.equal((await accept(token, user.id)).ok, true);
    assert.deepEqual(
      await grantsFor(user.id),
      [`project:${id.offeredProject}`],
      "the invitation named a project and no grant was created",
    );
  });

  test("several anchors all materialize", pgOnly ?? {}, async () => {
    const user = await makeUser("many-grants");
    const token = await issueRestricted({
      email: user.email,
      scope: [
        { entityType: "opportunity", entityId: id.offeredOpp },
        { entityType: "project", entityId: id.offeredProject },
      ],
    });

    assert.equal((await accept(token, user.id)).ok, true);
    assert.deepEqual(
      await grantsFor(user.id),
      [`opportunity:${id.offeredOpp}`, `project:${id.offeredProject}`].sort(),
      "an invitation naming two anchors did not produce two grants",
    );
  });

  test("the member can actually reach the work they were given", pgOnly ?? {}, async () => {
    // The point of materialization, asserted through the boundary rather than
    // through the grant table: a grant that does not change what RLS returns
    // would be bookkeeping, not access.
    const user = await makeUser("can-reach");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
    });
    assert.equal((await accept(token, user.id)).ok, true);

    const visible = await asRestricted(user.id, () =>
      db.opportunity.findMany({ select: { id: true } }),
    );
    const ids = visible.map((o) => o.id);
    assert.deepEqual(
      ids,
      [id.offeredOpp],
      "the restricted member does not see exactly the opportunity they were invited to",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-closed on anchors that cannot be honoured
// ---------------------------------------------------------------------------

describe("an invitation whose anchors cannot be honoured is refused whole", () => {
  test("an anchor that does not exist fails the acceptance", pgOnly ?? {}, async () => {
    const user = await makeUser("bad-anchor");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: "cnonexistentanchorid000000" }],
    });

    const result = await accept(token, user.id);
    assert.equal(
      result.ok,
      false,
      "acceptance succeeded with an anchor that does not exist — the member joined " +
        "restricted and silently received nothing",
    );

    const membership = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: user.id },
      select: { id: true },
    });
    assert.equal(membership, null, "a membership was left behind by a refused acceptance");
    const invitation = await observer.workspaceInvitation.findFirst({
      where: { workspaceId: A.workspaceId, email: user.email },
      select: { acceptedAt: true },
    });
    assert.equal(
      invitation?.acceptedAt,
      null,
      "the invitation was burned by an acceptance that did not grant what it promised",
    );
  });

  test("an anchor belonging to another workspace is never materialized", pgOnly ?? {}, async () => {
    // Injection: the payload names a real record, in a real workspace, that
    // this invitation has no business granting. Trusting the id because it
    // arrived in an invitation is the mistake this proves against.
    const user = await makeUser("cross-ws");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.foreignOpp }],
    });

    const result = await accept(token, user.id);
    assert.equal(result.ok, false, "an invitation naming another workspace's record was accepted");

    const anywhere = await observer.recordGrant.findMany({
      where: { userId: user.id },
      select: { workspaceId: true, anchorId: true },
    });
    assert.deepEqual(
      anywhere,
      [],
      "a grant was written for a record in a workspace the invitation could not reach",
    );
  });

  test("one bad anchor among good ones materializes nothing", pgOnly ?? {}, async () => {
    // The invariant in one test: a restricted membership must never exist in a
    // partially-materialized state. Two valid anchors and one invalid one must
    // leave no membership and no grants at all — not two grants out of three.
    const user = await makeUser("partial");
    const token = await issueRestricted({
      email: user.email,
      scope: [
        { entityType: "opportunity", entityId: id.offeredOpp },
        { entityType: "project", entityId: id.offeredProject },
        { entityType: "opportunity", entityId: id.foreignOpp },
      ],
    });

    const result = await accept(token, user.id);
    assert.equal(result.ok, false, "a partially-honourable invitation was accepted");
    assert.deepEqual(
      await grantsFor(user.id),
      [],
      "grants were written for the valid anchors while the invitation as a whole failed — " +
        "the member exists in a state nobody authorised",
    );
    const membership = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: user.id },
      select: { id: true },
    });
    assert.equal(membership, null, "a membership survived a failed materialization");
  });

  test("an anchor naming a record of the wrong kind is refused", pgOnly ?? {}, async () => {
    // The id is a real project; the payload calls it an opportunity. Anchor
    // type and anchor id have to be revalidated together, not separately.
    const user = await makeUser("wrong-kind");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.offeredProject }],
    });

    const result = await accept(token, user.id);
    assert.equal(result.ok, false, "an anchor whose type did not match its record was accepted");
    assert.deepEqual(
      await grantsFor(user.id),
      [],
      "a grant was written naming a project as an opportunity",
    );
  });

  test("a malformed scope payload is refused rather than ignored", pgOnly ?? {}, async () => {
    // Tampering, or a schema change that outlives its writer. Either way the
    // safe reading of "I cannot parse what access this grants" is none.
    const user = await makeUser("tampered");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
    });
    await observer.workspaceInvitation.updateMany({
      where: { workspaceId: A.workspaceId, email: user.email },
      data: { scope: '[{"entityType":"opportunity"' },
    });

    const result = await accept(token, user.id);
    assert.equal(
      result.ok,
      false,
      "an invitation whose scope payload could not be parsed was accepted anyway",
    );
    const membership = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: user.id },
      select: { scopeMode: true },
    });
    assert.equal(membership, null, "a membership was created from an unparseable scope");
  });

  test("a restricted invitation naming no anchors is refused", pgOnly ?? {}, async () => {
    // Joining restricted with an empty grant set is a member who can see
    // nothing and cannot be told why. If that is ever wanted it should be an
    // explicit choice, not the result of an empty array.
    const user = await makeUser("empty-scope");
    const token = await issueRestricted({ email: user.email, scope: [] });

    const result = await accept(token, user.id);
    assert.equal(
      result.ok,
      false,
      "a restricted invitation with no anchors was accepted, creating a member who can " +
        "reach nothing at all",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The boundary still holds for whoever gets through it
// ---------------------------------------------------------------------------

describe("a restricted member's reach, once activated", () => {
  let held = { id: "", email: "" };

  before(async () => {
    if (!isPostgres) return;
    held = await makeUser("holder");
    // Activated the only way available today: membership written directly,
    // grant created through the real server action. When acceptance
    // materializes grants this becomes redundant, and these assertions stay.
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: held.id, role: "member", scopeMode: "restricted" },
    });
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const granted = await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({
        workspaceId: A.workspaceId,
        userId: held.id,
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      }),
    );
    assert.equal(granted.ok, true, `grant failed: ${JSON.stringify(granted)}`);
  });

  test("sees the granted anchor and not the withheld one", pgOnly ?? {}, async () => {
    const ids = (await asRestricted(held.id, () => db.opportunity.findMany({ select: { id: true } })))
      .map((o) => o.id);
    assert.ok(ids.includes(id.offeredOpp), "the granted opportunity is not visible");
    assert.ok(!ids.includes(id.withheldOpp), "an ungranted opportunity is visible");
  });

  test("reaches a contact through granted work, and no further", pgOnly ?? {}, async () => {
    const ids = (await asRestricted(held.id, () => db.contact.findMany({ select: { id: true } })))
      .map((c) => c.id);
    assert.ok(ids.includes(id.offeredContact), "Step 3B: a contact on granted work is not reachable");
    assert.ok(!ids.includes(id.withheldContact), "a contact on withheld work is reachable");
  });

  test("never sees a deal, even on work they hold", pgOnly ?? {}, async () => {
    const deals = await asRestricted(held.id, () => db.deal.findMany({ select: { id: true } }));
    assert.deepEqual(deals, [], "a restricted member saw a deal");
  });

  test("cannot start a new anchor and thereby widen their own reach", pgOnly ?? {}, async () => {
    const { mayCreateAnchor } = await import("../../src/lib/auth/access");
    assert.equal(
      mayCreateAnchor({ role: "member", scopeMode: "restricted" }),
      false,
      "a restricted member may create an anchor, which would let them grant themselves work",
    );
  });

  test("with every grant revoked, sees nothing — and does not fall back to the workspace",
    pgOnly ?? {},
    async () => {
      const revoked = await makeUser("revoked");
      await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: revoked.id, role: "member", scopeMode: "restricted" },
      });
      const { grantRecordAccess, revokeRecordAccess } = await import("../../src/lib/actions/record-grants");
      const grantArgs = {
        workspaceId: A.workspaceId,
        userId: revoked.id,
        anchorType: "opportunity" as const,
        anchorId: id.offeredOpp,
      };
      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
      assert.equal((await runAsTestIdentity(A.ownerId, () => grantRecordAccess(grantArgs))).ok, true);

      // Positive control: with the grant, they see exactly one.
      const before = await asRestricted(revoked.id, () => db.opportunity.findMany({ select: { id: true } }));
      assert.equal(before.length, 1, "the fixture never granted anything, so revoking proves nothing");

      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
      const gone = await runAsTestIdentity(A.ownerId, () => revokeRecordAccess(grantArgs));
      assert.equal(gone.ok, true, `revoke failed: ${JSON.stringify(gone)}`);

      const after = await asRestricted(revoked.id, () => db.opportunity.findMany({ select: { id: true } }));
      assert.deepEqual(after, [], "with the last grant gone the member still sees opportunities");
      const contacts = await asRestricted(revoked.id, () => db.contact.findMany({ select: { id: true } }));
      assert.deepEqual(contacts, [], "with no grants the member still reaches contacts");
    });

  test("a full-workspace member of the same workspace is unaffected", pgOnly ?? {}, async () => {
    const ids = (
      await withTenantContext(
        { workspaceIds: [A.workspaceId], userId: A.memberId, restrictedWorkspaceIds: [] },
        () => db.opportunity.findMany({ select: { id: true } }),
      )
    ).map((o) => o.id);
    assert.ok(ids.includes(id.offeredOpp) && ids.includes(id.withheldOpp),
      "a full-workspace member lost access while restriction was being activated");
  });
});

// ---------------------------------------------------------------------------
// 5. Scope-mode transitions
// ---------------------------------------------------------------------------

describe("moving a membership between scopes", () => {
  test("workspace to restricted replaces the grant set with exactly what was named",
    pgOnly ?? {},
    async () => {
      const user = await makeUser("to-restricted");
      const membership = await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "workspace" },
        select: { id: true },
      });
      // A grant left over from some earlier life. Replacement must not keep it.
      await observer.recordGrant.create({
        data: {
          workspaceId: A.workspaceId, userId: user.id, membershipId: membership.id,
          anchorType: "opportunity", anchorId: id.withheldOpp,
        },
      });

      const { setMemberScope } = await import("../../src/lib/actions/settings");
      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
      const result = await runAsTestIdentity(A.ownerId, () =>
        setMemberScope({
          workspaceId: A.workspaceId,
          userId: user.id,
          scopeMode: "restricted",
          anchors: [{ entityType: "opportunity", entityId: id.offeredOpp }],
        }),
      );
      assert.equal(result.ok, true, `transition failed: ${JSON.stringify(result)}`);

      assert.deepEqual(
        await grantsFor(user.id),
        [`opportunity:${id.offeredOpp}`],
        "the prior grant survived a replacement",
      );
      const row = await observer.workspaceMember.findFirst({
        where: { id: membership.id }, select: { scopeMode: true },
      });
      assert.equal(row?.scopeMode, "restricted", "the scope mode did not change");
    });

  test("restricted to workspace deletes every grant", pgOnly ?? {}, async () => {
    const user = await makeUser("to-workspace");
    const membership = await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
      select: { id: true },
    });
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId, userId: user.id, membershipId: membership.id,
        anchorType: "opportunity", anchorId: id.offeredOpp,
      },
    });
    assert.equal((await grantsFor(user.id)).length, 1, "the fixture granted nothing");

    const { setMemberScope } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      setMemberScope({ workspaceId: A.workspaceId, userId: user.id, scopeMode: "workspace", anchors: [] }),
    );
    assert.equal(result.ok, true, `transition failed: ${JSON.stringify(result)}`);

    assert.deepEqual(
      await grantsFor(user.id),
      [],
      "grants survived a return to full access, ready to reapply the next time somebody " +
        "is restricted",
    );
  });

  test("restricted to restricted replaces rather than adds", pgOnly ?? {}, async () => {
    const user = await makeUser("replace");
    const membership = await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
      select: { id: true },
    });
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId, userId: user.id, membershipId: membership.id,
        anchorType: "opportunity", anchorId: id.offeredOpp,
      },
    });

    const { setMemberScope } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      setMemberScope({
        workspaceId: A.workspaceId,
        userId: user.id,
        scopeMode: "restricted",
        anchors: [{ entityType: "project", entityId: id.offeredProject }],
      }),
    );
    assert.equal(result.ok, true, `transition failed: ${JSON.stringify(result)}`);
    assert.deepEqual(
      await grantsFor(user.id),
      [`project:${id.offeredProject}`],
      "the replacement added to the grant set instead of replacing it",
    );
  });

  test("a restricted invitation with no anchors is refused at issue", pgOnly ?? {}, async () => {
    const { inviteTeamMember } = await import("../../src/lib/actions/team");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      inviteTeamMember({
        workspaceId: A.workspaceId,
        email: `empty-${Date.now().toString(36)}@activation.invalid`,
        role: "member",
        scopeMode: "restricted",
        scope: [],
      }),
    );
    assert.equal(result.ok, false, "an invitation to nothing in particular was issued");
  });

  test("a scope change cannot name another workspace's record", pgOnly ?? {}, async () => {
    const user = await makeUser("cross-ws-scope");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "workspace" },
    });
    const { setMemberScope } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      setMemberScope({
        workspaceId: A.workspaceId,
        userId: user.id,
        scopeMode: "restricted",
        anchors: [{ entityType: "opportunity", entityId: id.foreignOpp }],
      }),
    );
    assert.equal(result.ok, false, "a scope change named another workspace's record");
    assert.deepEqual(await grantsFor(user.id), [], "a cross-workspace grant was written");
  });

  test("an owner can never be restricted", pgOnly ?? {}, async () => {
    const { setMemberScope } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    // A second owner, so the target is an owner who is not the actor.
    const other = await makeUser("second-owner");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: other.id, role: "owner", scopeMode: "workspace" },
    });
    const result = await runAsTestIdentity(A.ownerId, () =>
      setMemberScope({
        workspaceId: A.workspaceId,
        userId: other.id,
        scopeMode: "restricted",
        anchors: [{ entityType: "opportunity", entityId: id.offeredOpp }],
      }),
    );
    assert.equal(result.ok, false, "an owner was confined to particular records");
  });

  test("nobody changes their own scope", pgOnly ?? {}, async () => {
    const { setMemberScope } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      setMemberScope({
        workspaceId: A.workspaceId,
        userId: A.ownerId,
        scopeMode: "restricted",
        anchors: [{ entityType: "opportunity", entityId: id.offeredOpp }],
      }),
    );
    assert.equal(result.ok, false, "somebody changed their own level of access");
  });

  test("changing someone's role leaves their scope alone", pgOnly ?? {}, async () => {
    // Orthogonality, which the approved model requires and which a future
    // scope-setting action must not quietly break.
    const user = await makeUser("role-change");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });
    const { changeMemberRole } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      changeMemberRole({ workspaceId: A.workspaceId, userId: user.id, role: "manager" }),
    );
    assert.equal(result.ok, true, `role change failed: ${JSON.stringify(result)}`);

    const row = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: user.id },
      select: { role: true, scopeMode: true },
    });
    assert.equal(row?.role, "manager", "the role did not change");
    assert.equal(row?.scopeMode, "restricted", "changing a role silently changed the scope");
  });

  test("a restricted administrator cannot lift their own restriction", pgOnly ?? {}, async () => {
    // Role and scope are orthogonal, which means `restricted admin` is a
    // coherent state — and an admin holds members:manage. Two rules stop them
    // walking out: a restricted actor may not administer access at all, and
    // nobody changes their own scope. Either alone would do; both are asserted
    // because they fail in different directions.
    const user = await makeUser("restricted-admin");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "admin", scopeMode: "restricted" },
    });

    const { setMemberScope } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: user.id, workspace: A.workspaceId, global: user.id });
    const self = await runAsTestIdentity(user.id, () =>
      setMemberScope({ workspaceId: A.workspaceId, userId: user.id, scopeMode: "workspace", anchors: [] }),
    );
    assert.equal(self.ok, false, "a restricted admin lifted their own restriction");

    // And they cannot free somebody else either, which would be the same
    // escalation with an extra step and a friend.
    const friend = await makeUser("restricted-friend");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: friend.id, role: "member", scopeMode: "restricted" },
    });
    await resetRateLimit("mutation", { user: user.id, workspace: A.workspaceId, global: user.id });
    const other = await runAsTestIdentity(user.id, () =>
      setMemberScope({ workspaceId: A.workspaceId, userId: friend.id, scopeMode: "workspace", anchors: [] }),
    );
    assert.equal(other.ok, false, "a restricted admin changed somebody else's scope");
  });

  test("a restricted member cannot grant themselves more work", pgOnly ?? {}, async () => {
    // A restricted admin has members:manage. They must not be able to reach
    // grantRecordAccess for an anchor they cannot see — and, because the anchor
    // is read through their own context, they cannot. Regression assertion.
    const user = await makeUser("self-grant");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "admin", scopeMode: "restricted" },
    });
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: user.id, workspace: A.workspaceId, global: user.id });

    const result = await runAsTestIdentity(user.id, () =>
      grantRecordAccess({
        workspaceId: A.workspaceId,
        userId: user.id,
        anchorType: "opportunity",
        anchorId: id.withheldOpp,
      }),
    );
    assert.equal(result.ok, false, "a restricted admin granted themselves an unseen opportunity");
    assert.deepEqual(await grantsFor(user.id), [], "a self-grant was written");
  });

  test("the database refuses a grant written by its own beneficiary", pgOnly ?? {}, async () => {
    // The application refuses it above. This asks whether the boundary would
    // hold without that check, the way every other Step 3 rule does: the grant
    // table's only policy is the plain workspace rule, so a restricted member's
    // own context satisfies its WITH CHECK.
    const user = await makeUser("db-self-grant");
    const membership = await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
      select: { id: true },
    });

    // Every identity column is correct and every constraint is satisfied. The
    // only thing wrong with this row is who is writing it.
    let refused = false;
    try {
      await asRestricted(user.id, () =>
        db.recordGrant.create({
          data: {
            workspaceId: A.workspaceId,
            userId: user.id,
            membershipId: membership.id,
            anchorType: "opportunity",
            anchorId: id.withheldOpp,
          },
        }),
      );
    } catch {
      refused = true;
    }
    assert.equal(
      refused,
      true,
      "a restricted member inserted a grant for themselves naming work they cannot see — " +
        "the grant table would be enforced by the application alone, unlike every other " +
        "boundary here",
    );
    await observer.recordGrant.deleteMany({ where: { userId: user.id } });
  });
});

// ---------------------------------------------------------------------------
// 6. Lifecycle: removal, re-invitation, and what grants outlive
// ---------------------------------------------------------------------------

describe("what a grant outlives", () => {
  test("removing a member takes their grants with them", pgOnly ?? {}, async () => {
    const user = await makeUser("removed");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    assert.equal(
      (
        await runAsTestIdentity(A.ownerId, () =>
          grantRecordAccess({
            workspaceId: A.workspaceId,
            userId: user.id,
            anchorType: "opportunity",
            anchorId: id.offeredOpp,
          }),
        )
      ).ok,
      true,
    );
    assert.equal((await grantsFor(user.id)).length, 1, "the fixture granted nothing");

    const { removeMember } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const removed = await runAsTestIdentity(A.ownerId, () => removeMember(A.workspaceId, user.id));
    assert.equal(removed.ok, true, `removal failed: ${JSON.stringify(removed)}`);

    assert.deepEqual(
      await grantsFor(user.id),
      [],
      "the membership is gone and the grants remain — they will apply again to whoever " +
        "next holds this user id in this workspace",
    );
  });

  test("a removed member who rejoins does not inherit their old access", pgOnly ?? {}, async () => {
    // The consequence of the previous test, through real paths end to end.
    // Someone leaves the company, is later re-invited to one new pursuit, and
    // silently regains everything they held before.
    const user = await makeUser("rejoin");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({
        workspaceId: A.workspaceId,
        userId: user.id,
        anchorType: "opportunity",
        anchorId: id.withheldOpp,
      }),
    );

    const { removeMember } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    await runAsTestIdentity(A.ownerId, () => removeMember(A.workspaceId, user.id));

    // Re-invited to one different, smaller piece of work.
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
    });
    const rejoined = await accept(token, user.id);
    assert.equal(rejoined.ok, true, `re-acceptance failed: ${JSON.stringify(rejoined)}`);

    const visible = (
      await asRestricted(user.id, () => db.opportunity.findMany({ select: { id: true } }))
    ).map((o) => o.id);
    assert.ok(
      !visible.includes(id.withheldOpp),
      "a rejoining member regained access to work nobody granted them this time — their " +
        "grants from a previous membership were never cleaned up",
    );
  });

  test("deleting an anchor takes its grants with it", pgOnly ?? {}, async () => {
    const user = await makeUser("anchor-gone");
    const doomed = await observer.opportunity.create({
      data: { workspaceId: A.workspaceId, name: "Cancelled pursuit" },
      select: { id: true },
    });
    const membership = await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
      select: { id: true },
    });
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: user.id,
        membershipId: membership.id,
        anchorType: "opportunity",
        anchorId: doomed.id,
      },
    });

    // Through the real deletion path, not a raw delete: the cleanup lives in
    // the action that causes it.
    const { deleteOpportunity } = await import("../../src/lib/actions/opportunities");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const removed = await runAsTestIdentity(A.ownerId, () =>
      deleteOpportunity(doomed.id, "Cancelled pursuit"),
    );
    assert.equal(removed.ok, true, `deletion failed: ${JSON.stringify(removed)}`);

    assert.deepEqual(
      await grantsFor(user.id),
      [],
      "the opportunity is gone and a grant still names it — nothing removes a grant whose " +
        "anchor no longer exists",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Grant administration
// ---------------------------------------------------------------------------

describe("who may give and take access", () => {
  // A target who is genuinely restricted. Without this every refusal below
  // could be the "target is not restricted" rule firing instead of the rule
  // each test is named for — a suite that passes for the wrong reason.
  let target = { id: "", email: "" };

  before(async () => {
    if (!isPostgres) return;
    target = await makeUser("grant-target");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: target.id, role: "member", scopeMode: "restricted" },
    });
  });

  const anchorArgs = () => ({
    workspaceId: A.workspaceId,
    userId: target.id,
    anchorType: "opportunity" as const,
    anchorId: id.offeredOpp,
  });

  test("a member without members:manage cannot grant", pgOnly ?? {}, async () => {
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.viewerId, workspace: A.workspaceId, global: A.viewerId });
    const result = await runAsTestIdentity(A.viewerId, () => grantRecordAccess(anchorArgs()));
    assert.equal(result.ok, false, "a viewer granted record access");
  });

  test("a member without members:manage cannot revoke", pgOnly ?? {}, async () => {
    const { revokeRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.viewerId, workspace: A.workspaceId, global: A.viewerId });
    const result = await runAsTestIdentity(A.viewerId, () => revokeRecordAccess(anchorArgs()));
    assert.equal(result.ok, false, "a viewer revoked record access");
  });

  test("an anchor from another workspace cannot be granted", pgOnly ?? {}, async () => {
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({ ...anchorArgs(), anchorId: id.foreignOpp }),
    );
    assert.equal(result.ok, false, "an owner granted access to another workspace's record");
    assert.deepEqual(
      await observer.recordGrant.findMany({ where: { anchorId: id.foreignOpp } }),
      [],
      "a cross-workspace grant row was written",
    );
  });

  test("granting to someone outside the workspace is refused", pgOnly ?? {}, async () => {
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({ ...anchorArgs(), userId: B.ownerId }),
    );
    assert.equal(result.ok, false, "access was granted to a stranger, adding them by the back door");
  });

  test("granting the same anchor twice is idempotent", pgOnly ?? {}, async () => {
    const { grantRecordAccess, revokeRecordAccess } = await import("../../src/lib/actions/record-grants");
    const args = anchorArgs();
    for (let i = 0; i < 2; i++) {
      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
      const result = await runAsTestIdentity(A.ownerId, () => grantRecordAccess(args));
      assert.equal(result.ok, true, `grant ${i + 1} failed: ${JSON.stringify(result)}`);
    }
    const rows = await observer.recordGrant.findMany({
      where: { workspaceId: A.workspaceId, userId: target.id, anchorId: id.offeredOpp },
    });
    assert.equal(rows.length, 1, "granting twice created two rows");

    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    await runAsTestIdentity(A.ownerId, () => revokeRecordAccess(args));
  });

  test("a full-workspace member cannot be given a grant", pgOnly ?? {}, async () => {
    // A grant to somebody who already sees everything means nothing today and
    // would mean something the moment they were restricted. Refused rather
    // than stored.
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({ ...anchorArgs(), userId: A.memberId }),
    );
    assert.equal(result.ok, false, "an inert grant was written for a full-workspace member");
    assert.deepEqual(await grantsFor(A.memberId), [], "a dormant grant row was created");
  });

  test("an archived anchor cannot receive a new grant", pgOnly ?? {}, async () => {
    const archived = await observer.opportunity.create({
      data: { workspaceId: A.workspaceId, name: "Shelved pursuit", archivedAt: new Date() },
      select: { id: true },
    });
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({ ...anchorArgs(), anchorId: archived.id }),
    );
    assert.equal(result.ok, false, "access was granted to a record in the trash");
  });

  test("a restricted administrator cannot grant or revoke at all", pgOnly ?? {}, async () => {
    const admin = await makeUser("restricted-granter");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: admin.id, role: "admin", scopeMode: "restricted" },
    });
    const { grantRecordAccess, revokeRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: admin.id, workspace: A.workspaceId, global: admin.id });
    const gave = await runAsTestIdentity(admin.id, () => grantRecordAccess(anchorArgs()));
    assert.equal(gave.ok, false, "a restricted admin gave somebody access");
    await resetRateLimit("mutation", { user: admin.id, workspace: A.workspaceId, global: admin.id });
    const took = await runAsTestIdentity(admin.id, () => revokeRecordAccess(anchorArgs()));
    assert.equal(took.ok, false, "a restricted admin revoked somebody's access");
  });

  test("revoking something never granted is not an error", pgOnly ?? {}, async () => {
    const { revokeRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      revokeRecordAccess({ ...anchorArgs(), anchorId: id.withheldOpp }),
    );
    assert.equal(result.ok, true, "revoking an absent grant failed");
    if (result.ok) assert.equal(result.data.revoked, 0, "it claimed to have removed something");
  });
});

// ---------------------------------------------------------------------------
// 8. What a restricted member learns from the grant table itself
// ---------------------------------------------------------------------------

describe("the grant table is not a directory of work", () => {
  test("a restricted member cannot read other people's grants", pgOnly ?? {}, async () => {
    // 009 left this open deliberately, for the step that builds the screen
    // answering "who can reach this record?" — this one. Today RecordGrant
    // carries the plain workspace rule, so a restricted member can list every
    // grant in the workspace: the ids of work they were not given, and which
    // colleague holds each. That is the roster D5 keeps private, plus an index
    // of the records behind the boundary.
    const holder = await makeUser("other-holder");
    const watcher = await makeUser("watcher");
    const memberships: Record<string, string> = {};
    for (const u of [holder, watcher]) {
      const row = await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: u.id, role: "member", scopeMode: "restricted" },
        select: { id: true },
      });
      memberships[u.id] = row.id;
    }
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: holder.id,
        membershipId: memberships[holder.id],
        anchorType: "opportunity",
        anchorId: id.withheldOpp,
      },
    });
    // The watcher holds one of their own, so an empty result would not be
    // mistaken for the policy working.
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: watcher.id,
        membershipId: memberships[watcher.id],
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      },
    });

    const seen = await asRestricted(watcher.id, () =>
      db.recordGrant.findMany({ select: { userId: true, anchorId: true } }),
    );
    assert.ok(
      seen.some((g) => g.userId === watcher.id),
      "the reader cannot see their own grant either, so the policy is too tight",
    );
    const foreign = seen.filter((g) => g.userId !== watcher.id);
    assert.deepEqual(
      foreign,
      [],
      "a restricted member listed grants belonging to other people, learning the ids of " +
        `work they cannot see and who holds it: ${JSON.stringify(foreign)}`,
    );
  });

  test("a full-workspace administrator can still audit who reaches what", pgOnly ?? {}, async () => {
    // The control for the test above: narrowing restricted readers must not
    // blind the administrator whose screen this table exists to serve.
    const seen = await withTenantContext(
      { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] },
      () => db.recordGrant.findMany({ select: { userId: true } }),
    );
    assert.ok(
      seen.length > 0,
      "an owner cannot see any grants at all, so the audit direction is broken",
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Person-scoped AI output is unchanged by any of this
// ---------------------------------------------------------------------------

describe("S7 person-scoped AI output is untouched", () => {
  test("a restricted member cannot read another person's brief", pgOnly ?? {}, async () => {
    const user = await makeUser("ai-reader");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });
    await observer.aiInsight.create({
      data: {
        workspaceId: A.workspaceId,
        userId: A.ownerId,
        kind: "brief",
        entityType: "workspace",
        entityId: A.workspaceId,
        title: "Owner's brief",
        body: "Confidential to the owner",
      },
    });

    const seen = await asRestricted(user.id, () =>
      db.aiInsight.findMany({ select: { id: true, userId: true } }),
    );
    assert.deepEqual(
      seen.filter((i) => i.userId !== user.id),
      [],
      "a restricted member read an AI insight belonging to someone else",
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Membership identity consistency
// ---------------------------------------------------------------------------

describe("a grant names one membership, one workspace and one person", () => {
  /**
   * RecordGrant now carries three identity columns — membershipId, workspaceId
   * and userId — and the policies read one while the lifecycle reads another.
   * Two independently writable identities that can disagree is a defect waiting
   * for the day they do, so they are not independently writable: a single
   * composite foreign key points all three at the same membership row.
   *
   * These tests write through the raw client on purpose. The application would
   * never assemble such a row; the question is whether the database would
   * accept one if something did.
   */

  let alice = { id: "", email: "", membershipId: "" };
  let bob = { id: "", email: "", membershipId: "" };
  let foreignMembershipId = "";

  before(async () => {
    if (!isPostgres) return;
    const mk = async (label: string) => {
      const user = await makeUser(label);
      const row = await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
        select: { id: true },
      });
      return { ...user, membershipId: row.id };
    };
    alice = await mk("alice");
    bob = await mk("bob");
    foreignMembershipId = (
      await observer.workspaceMember.findFirstOrThrow({
        where: { workspaceId: B.workspaceId, userId: B.ownerId },
        select: { id: true },
      })
    ).id;
  });

  const refused = async (data: Record<string, unknown>, what: string) => {
    let threw = false;
    try {
      await observer.recordGrant.create({ data: data as never });
    } catch {
      threw = true;
    }
    if (!threw) {
      await observer.recordGrant.deleteMany({
        where: { anchorId: data.anchorId as string, userId: data.userId as string },
      });
    }
    assert.equal(threw, true, what);
  };

  test("a membership belonging to someone else is refused", pgOnly ?? {}, async () => {
    await refused(
      {
        workspaceId: A.workspaceId,
        userId: alice.id,
        membershipId: bob.membershipId,
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      },
      "a grant named Alice as the person and Bob's membership as the owner",
    );
  });

  test("a membership from another workspace is refused", pgOnly ?? {}, async () => {
    await refused(
      {
        workspaceId: A.workspaceId,
        userId: alice.id,
        membershipId: foreignMembershipId,
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      },
      "a grant in workspace A named a membership belonging to workspace B",
    );
  });

  test("a membership that does not exist is refused", pgOnly ?? {}, async () => {
    await refused(
      {
        workspaceId: A.workspaceId,
        userId: alice.id,
        membershipId: "cnosuchmembershipid000000",
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      },
      "a grant named a membership that was never created",
    );
  });

  test("a workspace that disagrees with the membership is refused", pgOnly ?? {}, async () => {
    await refused(
      {
        workspaceId: B.workspaceId,
        userId: alice.id,
        membershipId: alice.membershipId,
        anchorType: "opportunity",
        anchorId: id.foreignOpp,
      },
      "a grant claimed workspace B while naming a membership in workspace A",
    );
  });

  test("the three columns cannot be made to disagree after the fact", pgOnly ?? {}, async () => {
    // Creation is checked above; this is the same question asked of UPDATE,
    // which a composite foreign key also governs.
    const grant = await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: alice.id,
        membershipId: alice.membershipId,
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      },
      select: { id: true },
    });
    let threw = false;
    try {
      await observer.recordGrant.update({
        where: { id: grant.id },
        data: { userId: bob.id },
      });
    } catch {
      threw = true;
    }
    await observer.recordGrant.deleteMany({ where: { id: grant.id } });
    assert.equal(threw, true, "a grant was repointed at a different person after creation");
  });

  test("the application's own grants always agree", pgOnly ?? {}, async () => {
    // The positive control: every row the product writes satisfies the rule,
    // so the constraint is not merely unreachable.
    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const result = await runAsTestIdentity(A.ownerId, () =>
      grantRecordAccess({
        workspaceId: A.workspaceId,
        userId: alice.id,
        anchorType: "opportunity",
        anchorId: id.offeredOpp,
      }),
    );
    assert.equal(result.ok, true, `grant failed: ${JSON.stringify(result)}`);

    const row = await observer.recordGrant.findFirstOrThrow({
      where: { workspaceId: A.workspaceId, userId: alice.id, anchorId: id.offeredOpp },
      select: { membershipId: true, userId: true, workspaceId: true },
    });
    assert.equal(row.membershipId, alice.membershipId, "the grant named the wrong membership");
    assert.equal(row.userId, alice.id);
    assert.equal(row.workspaceId, A.workspaceId);
    await observer.recordGrant.deleteMany({ where: { userId: alice.id } });
  });

  test("deleting the membership row takes the grants with it, in the database",
    pgOnly ?? {},
    async () => {
      // No application code involved: the membership is deleted directly, and
      // the grants must still go. This is the backstop that makes the cleanup
      // in removeMember a convenience rather than the only thing standing
      // between a departure and a silent return of access.
      const user = await makeUser("cascade");
      const membership = await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
        select: { id: true },
      });
      await observer.recordGrant.create({
        data: {
          workspaceId: A.workspaceId,
          userId: user.id,
          membershipId: membership.id,
          anchorType: "opportunity",
          anchorId: id.offeredOpp,
        },
      });
      assert.equal((await grantsFor(user.id)).length, 1, "the fixture granted nothing");

      await observer.workspaceMember.delete({ where: { id: membership.id } });

      assert.deepEqual(
        await grantsFor(user.id),
        [],
        "the membership is gone and its grants survived the foreign key",
      );
    });
});

// ---------------------------------------------------------------------------
// 11. Concurrency
// ---------------------------------------------------------------------------

describe("two administrators at once", () => {
  /**
   * What the database already guarantees, and what it does not.
   *
   * Single-use acceptance and duplicate grants are held by a conditional update
   * and a unique index respectively — no extra machinery needed, and these
   * tests say so rather than assuming it. Replacement is the one that needed
   * help: two replacements starting from an empty grant set delete nothing,
   * block on nothing, and both insert, leaving the union of two sets. The
   * membership row lock in setMemberScope is there for exactly that case.
   */

  test("two simultaneous acceptances join once and grant once", pgOnly ?? {}, async () => {
    const user = await makeUser("race-accept");
    const token = await issueRestricted({
      email: user.email,
      scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
    });

    const { acceptInvitation } = await import("../../src/lib/actions/team");
    await resetRateLimit("mutation", { user: user.id, workspace: user.id, global: user.id });
    const [first, second] = await Promise.all([
      runAsTestIdentity(user.id, () => acceptInvitation(token)),
      runAsTestIdentity(user.id, () => acceptInvitation(token)),
    ]);

    const won = [first, second].filter((r) => r.ok).length;
    assert.equal(won, 1, `exactly one acceptance should win, ${won} did`);

    const memberships = await observer.workspaceMember.count({
      where: { workspaceId: A.workspaceId, userId: user.id },
    });
    assert.equal(memberships, 1, "the race produced more than one membership");
    assert.deepEqual(
      await grantsFor(user.id),
      [`opportunity:${id.offeredOpp}`],
      "the race produced a duplicated or missing grant set",
    );
  });

  test("two replacements leave one of the two sets, never their union",
    pgOnly ?? {},
    async () => {
      const user = await makeUser("race-replace");
      await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "workspace" },
      });

      const { setMemberScope } = await import("../../src/lib/actions/settings");
      const call = (entityId: string, entityType: "opportunity" | "project") =>
        setMemberScope({
          workspaceId: A.workspaceId,
          userId: user.id,
          scopeMode: "restricted",
          anchors: [{ entityType, entityId }],
        });

      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
      const results = await Promise.all([
        runAsTestIdentity(A.ownerId, () => call(id.offeredOpp, "opportunity")),
        runAsTestIdentity(A.ownerId, () => call(id.offeredProject, "project")),
      ]);
      assert.ok(results.some((r) => r.ok), `both replacements failed: ${JSON.stringify(results)}`);

      const grants = await grantsFor(user.id);
      assert.equal(
        grants.length,
        1,
        `the member ended up with ${grants.length} grants — two concurrent replacements ` +
          `produced a set nobody asked for: ${grants.join(", ")}`,
      );
    });

  test("a revocation racing a replacement does not resurrect the revoked grant",
    pgOnly ?? {},
    async () => {
      const user = await makeUser("race-revoke");
      const membership = await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
        select: { id: true },
      });
      await observer.recordGrant.create({
        data: {
          workspaceId: A.workspaceId, userId: user.id, membershipId: membership.id,
          anchorType: "opportunity", anchorId: id.offeredOpp,
        },
      });

      const { revokeRecordAccess } = await import("../../src/lib/actions/record-grants");
      const { setMemberScope } = await import("../../src/lib/actions/settings");
      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });

      await Promise.all([
        runAsTestIdentity(A.ownerId, () =>
          revokeRecordAccess({
            workspaceId: A.workspaceId, userId: user.id,
            anchorType: "opportunity", anchorId: id.offeredOpp,
          }),
        ),
        runAsTestIdentity(A.ownerId, () =>
          setMemberScope({
            workspaceId: A.workspaceId, userId: user.id, scopeMode: "restricted",
            anchors: [{ entityType: "project", entityId: id.offeredProject }],
          }),
        ),
      ]);

      const grants = await grantsFor(user.id);
      assert.ok(
        !grants.includes(`opportunity:${id.offeredOpp}`) || grants.length === 1,
        `the two operations interleaved into a state neither asked for: ${grants.join(", ")}`,
      );
    });

  test("removal racing a grant leaves no grant behind", pgOnly ?? {}, async () => {
    const user = await makeUser("race-remove");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });

    const { grantRecordAccess } = await import("../../src/lib/actions/record-grants");
    const { removeMember } = await import("../../src/lib/actions/settings");
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });

    await Promise.all([
      runAsTestIdentity(A.ownerId, () =>
        grantRecordAccess({
          workspaceId: A.workspaceId, userId: user.id,
          anchorType: "opportunity", anchorId: id.offeredOpp,
        }),
      ),
      runAsTestIdentity(A.ownerId, () => removeMember(A.workspaceId, user.id)),
    ]);

    const membership = await observer.workspaceMember.findFirst({
      where: { workspaceId: A.workspaceId, userId: user.id },
      select: { id: true },
    });
    if (!membership) {
      assert.deepEqual(
        await grantsFor(user.id),
        [],
        "the member was removed and a grant written by the losing race survived them",
      );
    }
  });
});
