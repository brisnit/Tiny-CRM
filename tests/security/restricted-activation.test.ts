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
  test("the server action cannot express restricted scope at all", async () => {
    // Characterization, and the activation gap stated plainly: the schema the
    // action validates has no scope fields, so a caller cannot ask for one and
    // an administrator has no way to invite somebody to particular work.
    const { inviteTeamMember } = await import("../../src/lib/actions/team");
    const email = `gap-${Date.now().toString(36)}@activation.invalid`;
    const result = await runAsTestIdentity(A.ownerId, () =>
      // Extra keys are what a caller would send if the field existed.
      (inviteTeamMember as unknown as (i: Record<string, unknown>) => Promise<{ ok: boolean }>)({
        workspaceId: A.workspaceId,
        email,
        role: "member",
        scopeMode: "restricted",
        scope: [{ entityType: "opportunity", entityId: id.offeredOpp }],
      }),
    );

    assert.equal(result.ok, true, "the invitation was refused for an unrelated reason");
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
  test("no server action can set a membership to restricted", async () => {
    // The activation gap, stated as a test. Every other decision in this file
    // depends on there being a supported way to make this transition; today
    // the only way is a direct database write.
    const settings = await import("../../src/lib/actions/settings");
    const team = await import("../../src/lib/actions/team");
    const grants = await import("../../src/lib/actions/record-grants");
    const exported = [
      ...Object.keys(settings),
      ...Object.keys(team),
      ...Object.keys(grants),
    ];
    const scopeSetters = exported.filter((name) => /scope/i.test(name));
    assert.notDeepEqual(
      scopeSetters,
      [],
      "no exported server action mentions scope — a membership can only be restricted by " +
        `writing to the database by hand. Exports seen: ${exported.join(", ")}`,
    );
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
    // coherent state — and an admin holds members:manage. Whatever action the
    // green phase adds must refuse this, or restriction is advisory.
    const user = await makeUser("restricted-admin");
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "admin", scopeMode: "restricted" },
    });

    const settings = await import("../../src/lib/actions/settings");
    const setter = (settings as Record<string, unknown>).setMemberScope;
    assert.ok(
      typeof setter === "function",
      "there is no scope-setting action yet, so the rule that a restricted admin cannot " +
        "free themselves is unwritten and unenforced",
    );
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
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });

    let refused = false;
    try {
      await asRestricted(user.id, () =>
        db.recordGrant.create({
          data: {
            workspaceId: A.workspaceId,
            userId: user.id,
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
        "the grant table is enforced only by the application, unlike every other boundary here",
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
    await observer.workspaceMember.create({
      data: { workspaceId: A.workspaceId, userId: user.id, role: "member", scopeMode: "restricted" },
    });
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: user.id,
        anchorType: "opportunity",
        anchorId: doomed.id,
      },
    });

    await observer.opportunity.delete({ where: { id: doomed.id } });

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
  const anchorArgs = () => ({
    workspaceId: A.workspaceId,
    userId: A.memberId,
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
    const args = { ...anchorArgs(), userId: A.memberId };
    for (let i = 0; i < 2; i++) {
      await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
      const result = await runAsTestIdentity(A.ownerId, () => grantRecordAccess(args));
      assert.equal(result.ok, true, `grant ${i + 1} failed: ${JSON.stringify(result)}`);
    }
    const rows = await observer.recordGrant.findMany({
      where: { workspaceId: A.workspaceId, userId: A.memberId, anchorId: id.offeredOpp },
    });
    assert.equal(rows.length, 1, "granting twice created two rows");

    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    await runAsTestIdentity(A.ownerId, () => revokeRecordAccess(args));
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
    for (const u of [holder, watcher]) {
      await observer.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: u.id, role: "member", scopeMode: "restricted" },
      });
    }
    await observer.recordGrant.create({
      data: {
        workspaceId: A.workspaceId,
        userId: holder.id,
        anchorType: "opportunity",
        anchorId: id.withheldOpp,
      },
    });

    const seen = await asRestricted(watcher.id, () =>
      db.recordGrant.findMany({ select: { userId: true, anchorId: true } }),
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
