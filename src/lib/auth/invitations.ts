import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { rootDb } from "@/lib/db";
import { diagTimer } from "@/lib/diag";
import { isPostgres } from "@/lib/env";
import { log } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Invitations to join a workspace.
 *
 * ---------------------------------------------------------------------------
 * Why this is not an AuthToken
 * ---------------------------------------------------------------------------
 *
 * `AuthToken.userId` is required and foreign-keyed to `User`. An invitation is
 * addressed to an email that may have no account at all yet, so it cannot be a
 * row in that table. What carries over is the *technique*, which is the part
 * that makes a reset link safe:
 *
 *  - 32 bytes from the CSPRNG, base64url. Not a UUID.
 *  - Only the SHA-256 is stored. A database copy yields no usable link.
 *  - Single use, through a conditional update on `acceptedAt IS NULL`, so two
 *    simultaneous redemptions cannot both win.
 *  - Short-lived: seven days, long enough to survive a weekend and an inbox.
 *  - Superseded on re-issue, so an earlier link stops working the moment a new
 *    one is sent to the same address.
 *
 * ---------------------------------------------------------------------------
 * How a non-member reads their own invitation
 * ---------------------------------------------------------------------------
 *
 * Tenant context is derived from the caller's memberships, and the whole point
 * of an invitation is that the person holding it has none yet. So the ordinary
 * policy — "is this row's workspace in my context?" — can never be satisfied on
 * the one read that matters.
 *
 * The first attempt at this read through `rootDb`, on the reasoning that it
 * bypasses the ambient transaction. It does, and it does **not** bypass
 * row-level security: it connects as the same restricted role. Every acceptance
 * test passed on SQLite, which has no policies, and every one failed on
 * PostgreSQL. The lesson is in the code now rather than only in a commit
 * message: `rootDb` is not an authorisation escape hatch.
 *
 * The rule is instead expressed where it belongs, as two extra policies in
 * prisma/postgres/002_row_level_security.sql:
 *
 *   invitation_by_token        you may read the single row whose token hash you
 *                              can already produce — the token is the credential
 *   invitation_addressed_to_me you may read invitations sent to your own address
 *
 * `withInvitationToken` below sets the transaction-local setting the first one
 * reads. Everything that *writes* — the membership, the acceptance stamp — runs
 * inside a tenant context built from the invitation's own workspace, and the
 * database checks the invitation independently there: see the third arm of
 * `member_bootstrap_self_only` in prisma/postgres/004_workspace_bootstrap.sql.
 */

/** Seven days. Long enough for a weekend and a full inbox, short enough to expire. */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationScopeMode = "workspace" | "restricted";

/** A record the invitation grants access to. Unused until scoped access ships. */
export type InvitationScopeEntry = {
  entityType: "project" | "opportunity";
  entityId: string;
};

export type IssuedInvitation = {
  id: string;
  /** Returned exactly once, to put in an email, and then forgotten. */
  token: string;
  expiresAt: Date;
};

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Addresses are compared case-insensitively; store what we compare. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type IssueInput = {
  workspaceId: string;
  email: string;
  role: string;
  invitedById: string;
  scopeMode?: InvitationScopeMode;
  scope?: InvitationScopeEntry[];
};

/**
 * Issues an invitation, superseding any outstanding one for the same address.
 *
 * Re-inviting is the same operation as inviting: the previous link is revoked
 * in the same transaction, so a forwarded or leaked earlier email stops working
 * the moment a replacement is sent. That also makes "resend" and "invite again"
 * indistinguishable from the outside, which is what a person expects.
 *
 * Runs inside the workspace's tenant context, so RLS gates the write.
 */
export async function issueInvitation(input: IssueInput): Promise<IssuedInvitation> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInvitationToken(token);
  const email = normaliseEmail(input.email);
  const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);

  const created = await withTenantContext(
    { workspaceIds: [input.workspaceId], userId: input.invitedById },
    async (tx) => {
      // Supersede first, in the same transaction. Two people inviting the same
      // address at once therefore leave exactly one live invitation.
      await tx.workspaceInvitation.updateMany({
        where: {
          workspaceId: input.workspaceId,
          email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), revokedById: input.invitedById },
      });

      return tx.workspaceInvitation.create({
        data: {
          workspaceId: input.workspaceId,
          email,
          role: input.role,
          invitedById: input.invitedById,
          scopeMode: input.scopeMode ?? "workspace",
          scope: JSON.stringify(input.scope ?? []),
          tokenHash,
          expiresAt,
        },
        select: { id: true },
      });
    },
  );

  return { id: created.id, token, expiresAt };
}

export type InvitationFailure = "not_found" | "expired" | "revoked" | "already_accepted";

export type InvitationView = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: string;
  scopeMode: string;
  invitedByName: string | null;
  expiresAt: Date;
};

export type InvitationLookup =
  | { ok: true; invitation: InvitationView }
  | { ok: false; reason: InvitationFailure };

/**
 * Resolves a token to the invitation it names.
 *
 * The failure reasons are distinguished here so the *acceptance page* can say
 * something useful to the person who clicked. They are deliberately NOT
 * distinguished in what reaches a stranger: the page renders one "this link is
 * no longer valid" state for every failure, because telling an unknown visitor
 * that a token was "already accepted" confirms the invitation existed.
 */
/**
 * Runs one read with `app.invitation_token` set, so the `invitation_by_token`
 * policy admits exactly the row the caller already holds the token for.
 *
 * Transaction-local, like every other tenant setting: a pooled connection must
 * not carry a token into the next request. On SQLite there are no policies, so
 * this is a pass-through — which is precisely why the gap this closes was
 * invisible locally.
 */
async function withInvitationToken<T>(
  tokenHash: string,
  fn: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Temporary checkpoints; see src/lib/diag.ts. Off unless BROWSER_DIAG=1.
  const trace = diagTimer("invite.db");
  trace.mark("enter", { engine: isPostgres ? "postgres" : "sqlite" });

  if (!isPostgres) {
    trace.mark("sqlite:query:start");
    const result = await fn(rootDb as unknown as Prisma.TransactionClient);
    trace.mark("sqlite:query:end");
    return result;
  }

  trace.mark("pg:transaction:start");
  const result = await rootDb.$transaction(async (tx) => {
    trace.mark("pg:transaction:opened");
    await tx.$executeRaw`SELECT set_config('app.invitation_token', ${tokenHash}, true)`;
    trace.mark("pg:set_config:done");
    const inner = await fn(tx);
    trace.mark("pg:query:end");
    return inner;
  });
  trace.mark("pg:transaction:committed");
  return result;
}

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  // Temporary checkpoints; see src/lib/diag.ts. Off unless BROWSER_DIAG=1.
  const trace = diagTimer("invite.lookup");
  trace.mark("enter");

  if (!token || token.length > 200) {
    trace.mark("rejected-by-shape");
    return { ok: false, reason: "not_found" };
  }

  trace.mark("hash:start");
  const tokenHash = hashInvitationToken(token);
  trace.mark("hash:end");
  const row = await withInvitationToken(tokenHash, (tx) =>
    tx.workspaceInvitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        workspaceId: true,
        email: true,
        role: true,
        scopeMode: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        workspace: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    }),
  );

  trace.mark("row:fetched", { found: Boolean(row) });

  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.acceptedAt) return { ok: false, reason: "already_accepted" };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "expired" };
  trace.mark("classified-live");

  return {
    ok: true,
    invitation: {
      id: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      email: row.email,
      role: row.role,
      scopeMode: row.scopeMode,
      invitedByName: row.invitedBy?.name ?? null,
      expiresAt: row.expiresAt,
    },
  };
}

export type AcceptFailure = InvitationFailure | "email_mismatch" | "already_member";

export type AcceptResult =
  | { ok: true; workspaceId: string; workspaceName: string; role: string }
  | { ok: false; reason: AcceptFailure };

/**
 * Redeems an invitation for one signed-in account.
 *
 * The order here is the whole point, and it is the fix for a real defect: the
 * membership is created *before* anything asks whether this account has one.
 * `src/app/(app)/layout.tsx` redirects to /welcome while a user has no
 * workspace, and `completeOnboarding` provisions one when it finds none — so an
 * invited person who signed up and reached onboarding first would be handed
 * "their" workspace and land in an empty CRM, wondering where the team went.
 *
 * Both the acceptance stamp and the membership are written in one transaction,
 * so a failure cannot burn the token without granting the access it promised.
 */
export async function acceptInvitation(
  token: string,
  user: { id: string; email: string },
): Promise<AcceptResult> {
  const found = await lookupInvitation(token);
  if (!found.ok) return { ok: false, reason: found.reason };
  return grantMembership(found.invitation, user);
}

/**
 * Accepts by id rather than by token, for a signed-in person whose address the
 * invitation names.
 *
 * The welcome screen offers this: they never clicked the emailed link, but they
 * are authenticated as the addressee, which is at least as strong a proof as
 * holding a link sent to that inbox. The email is still compared in
 * `grantMembership`, so the id alone grants nothing.
 */
export async function acceptInvitationById(
  invitationId: string,
  user: { id: string; email: string },
): Promise<AcceptResult> {
  // `invitation_addressed_to_me` needs `app.user_id` and nothing else, so an
  // empty workspace context is exactly right here: it proves who is asking
  // without claiming membership of anything.
  const row = await withTenantContext({ workspaceIds: [], userId: user.id }, (tx) =>
    tx.workspaceInvitation.findUnique({
      where: { id: invitationId },
      select: {
        id: true,
        workspaceId: true,
        email: true,
        role: true,
        scopeMode: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        workspace: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    }),
  );

  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.acceptedAt) return { ok: false, reason: "already_accepted" };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "expired" };

  return grantMembership(
    {
      id: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace?.name ?? "the workspace",
      email: row.email,
      role: row.role,
      scopeMode: row.scopeMode,
      invitedByName: row.invitedBy?.name ?? null,
      expiresAt: row.expiresAt,
    },
    user,
  );
}

/**
 * The write both acceptance paths share.
 *
 * The order here is the whole point, and it is the fix for a real defect:
 * the membership is created *before* anything asks whether this account has
 * one. `src/app/(app)/layout.tsx` redirects to /welcome while a user has no
 * workspace, and `completeOnboarding` provisions one when it finds none — so an
 * invited person who reached onboarding first would be handed "their" workspace
 * and land in an empty CRM, wondering where the team went.
 */
async function grantMembership(
  invitation: InvitationView,
  user: { id: string; email: string },
): Promise<AcceptResult> {
  // The address is the binding. A token delivered to one inbox must not be
  // redeemable by a different account, even a legitimate one.
  if (normaliseEmail(user.email) !== normaliseEmail(invitation.email)) {
    log.info("invitation rejected: email mismatch", { invitationId: invitation.id });
    return { ok: false, reason: "email_mismatch" };
  }

  return withTenantContext(
    { workspaceIds: [invitation.workspaceId], userId: user.id },
    async (tx) => {
      const existing = await tx.workspaceMember.findFirst({
        where: { workspaceId: invitation.workspaceId, userId: user.id },
        select: { id: true },
      });

      // The membership is created *before* the invitation is stamped, and the
      // order is not cosmetic. `member_bootstrap_self_only` admits this INSERT
      // only while a live invitation exists for this address — and an
      // invitation already marked accepted is not live. Claiming first made the
      // database refuse the one write the flow exists to perform, on PostgreSQL
      // only, which is exactly the kind of thing SQLite cannot show you.
      if (!existing) {
        await tx.workspaceMember.create({
          data: {
            workspaceId: invitation.workspaceId,
            userId: user.id,
            role: invitation.role,
          },
        });
      }

      // Single use, claimed after the fact but inside the same transaction: if
      // another redemption won the race this matches nothing, the throw rolls
      // the membership back with it, and neither caller ends up half-joined.
      const claimed = await tx.workspaceInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date(), acceptedByUserId: user.id },
      });
      if (claimed.count === 0) throw new AlreadyAccepted();

      return {
        ok: true as const,
        workspaceId: invitation.workspaceId,
        workspaceName: invitation.workspaceName,
        role: invitation.role,
      };
    },
    // Its own transaction, deliberately. The caller is authenticated but may be
    // a member of nothing, so an ambient context opened from their memberships
    // contains no workspace at all — and `withTenantContext` reuses an ambient
    // transaction rather than re-issuing SET LOCAL inside it. Without this the
    // membership INSERT would run with an empty `app.workspace_ids` and RLS
    // would refuse it.
    { isolated: true },
  ).catch((error: unknown) => {
    if (error instanceof AlreadyAccepted) {
      return { ok: false as const, reason: "already_accepted" as const };
    }
    throw error;
  });
}

/** Rolls the transaction back when a concurrent redemption won the race. */
class AlreadyAccepted extends Error {
  constructor() {
    super("invitation already accepted");
    this.name = "AlreadyAccepted";
  }
}

/**
 * Live invitations addressed to one email address.
 *
 * Read by the welcome screen so an invited person is offered the workspace they
 * were invited to *before* the button that creates one of their own. That is
 * the whole fix for "the teammate ended up in an empty CRM": onboarding still
 * guarantees a workspace if they ask for one, but asking is now a deliberate
 * choice made next to an obvious alternative, rather than the only path
 * forward.
 *
 * Runs on `rootDb` for the same reason the token lookup does — the person has
 * no membership yet, so there is no tenant context that could see these rows.
 * It is keyed on the caller's own authenticated address and returns nothing
 * else, so it discloses only what was already sent to that inbox.
 */
export async function pendingInvitationsFor(user: { id: string; email: string }) {
  // The whole identity, not a bare address. An earlier signature took an email
  // on its own, which made "show me the invitations sent to somebody else" a
  // well-typed call — protected on PostgreSQL by `invitation_addressed_to_me`
  // and by nothing at all on SQLite. Taking the id and the address together
  // makes the mismatch unrepresentable, and the policy stays as the second
  // layer rather than the only one.
  const rows = await withTenantContext({ workspaceIds: [], userId: user.id }, (tx) =>
    tx.workspaceInvitation.findMany({
    where: {
      email: normaliseEmail(user.email),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      role: true,
      expiresAt: true,
      workspace: { select: { id: true, name: true } },
      invitedBy: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    expiresAt: row.expiresAt,
    workspaceId: row.workspace.id,
    workspaceName: row.workspace.name,
    invitedByName: row.invitedBy?.name ?? null,
  }));
}

/**
 * Whether this account arrived through an invitation it has already accepted.
 *
 * Read by onboarding, which must not provision a workspace for someone who just
 * joined one. Cheap: an indexed lookup on an address the caller already holds.
 */
export async function hasAcceptedInvitation(userId: string): Promise<boolean> {
  const count = await rootDb.workspaceInvitation.count({
    where: { acceptedByUserId: userId },
  });
  return count > 0;
}

/** The pending and recent invitations for one workspace, for the Team screen. */
export async function listInvitations(
  workspaceId: string,
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? rootDb;
  return client.workspaceInvitation.findMany({
    where: { workspaceId },
    select: {
      id: true,
      email: true,
      role: true,
      scopeMode: true,
      createdAt: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      invitedBy: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/** Pending means: not accepted, not revoked, not expired. */
export function invitationStatus(invitation: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): "pending" | "accepted" | "revoked" | "expired" {
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  if (invitation.expiresAt <= new Date()) return "expired";
  return "pending";
}
