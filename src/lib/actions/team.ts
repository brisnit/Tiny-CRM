"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit, guard, readWorkspaceId, revalidateLayout, revalidatePathSafely,
  workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertCanAssignRole, requireActor } from "@/lib/auth/access";
import { ROLES } from "@/lib/auth/permissions";
import {
  INVITATION_LIFETIME_MS, acceptInvitation as redeemInvitation,
  acceptInvitationById as redeemById, issueInvitation, lookupInvitation, normaliseEmail,
} from "@/lib/auth/invitations";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { invitationEmail, sendMail } from "@/lib/mail";
import { log } from "@/lib/logger";
import { appOrigin } from "@/lib/origin";
import { recordAudit } from "@/lib/audit";
import { WORKSPACE_ROLE } from "@/lib/enums";
import { zId } from "@/lib/validation/common";

/**
 * Team membership: invitations in, and the lifecycle of one once it is out.
 *
 * Role changes and removal already live in `settings.ts` with their owner-safety
 * rules, and stay there. This file is the part that did not exist: getting a
 * person into a workspace in the first place.
 *
 * Three properties are load-bearing and each is enforced here rather than in the
 * UI:
 *
 *  - **A role can never be granted above the granter's own.** Checked at issue
 *    *and again* at acceptance, because an owner may have been demoted in the
 *    days between sending an invitation and its being opened.
 *  - **Nothing reveals whether an address has a Tiny account.** Inviting an
 *    unknown address and a known one produce the same result, take a comparable
 *    path, and say the same thing.
 *  - **Accepting joins an existing workspace and never creates one.** See the
 *    ordering note in `auth/invitations.ts`.
 */

const inviteSchema = z.object({
  workspaceId: zId,
  // Deliberately permissive on shape and strict on length: an address that
  // fails delivery is a better outcome than a valid address rejected by a
  // clever regex.
  email: z.string().trim().min(3).max(320).email("Enter a valid email address"),
  role: z.enum(ROLES),
});

export async function inviteTeamMember(
  input: z.input<typeof inviteSchema>,
): Promise<ActionResult<{ email: string; role: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = inviteSchema.parse(input);
        const workspaceId = actor.workspaceId;
        const email = normaliseEmail(data.email);

        // An admin cannot mint an owner. The same rule that governs changing
        // somebody's role governs offering one.
        assertCanAssignRole(actor, data.role);

        if (email === normaliseEmail(actor.identity.email)) {
          throw new AppError("validation", "You are already in this workspace.");
        }

        const workspace = await db.workspace.findFirst({
          where: { id: workspaceId },
          select: { name: true },
        });
        if (!workspace) throw new AppError("not_found", "That workspace no longer exists.");

        // Already a member? Say so — this is not an enumeration leak, because
        // the caller can already see every member of their own workspace.
        const existingMember = await db.workspaceMember.findFirst({
          where: { workspaceId, user: { email } },
          select: { id: true },
        });
        if (existingMember) {
          throw new AppError("conflict", "That person is already in this workspace.");
        }

        const invitation = await issueInvitation({
          workspaceId,
          email,
          role: data.role,
          invitedById: actor.identity.id,
        });

        await deliver({
          token: invitation.token,
          email,
          inviterName: actor.identity.name,
          workspaceName: workspace.name,
          role: data.role,
        });

        await audit(actor, {
          workspaceId,
          action: "member.invited",
          entityType: "invitation",
          entityId: invitation.id,
          summary: `Invited someone as ${data.role}`,
          // The address is the point of the record; the token never is.
          metadata: { email, role: data.role, scopeMode: "workspace" },
        });

        revalidatePathSafely("/settings/team");
        return { email, role: data.role };
      },
    ),
  );
}

const invitationSchema = z.object({ workspaceId: zId, invitationId: zId });

/**
 * Sends the invitation again — with a *new* token.
 *
 * Re-issuing rather than re-sending the same link is the safer default: the
 * previous one is revoked in the same transaction, so an email forwarded to the
 * wrong place stops working the moment the real recipient asks for another.
 */
export async function resendInvitation(
  input: z.input<typeof invitationSchema>,
): Promise<ActionResult<{ email: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = invitationSchema.parse(input);
        const workspaceId = actor.workspaceId;

        const existing = await db.workspaceInvitation.findFirst({
          where: { id: data.invitationId, workspaceId },
          select: {
            id: true, email: true, role: true, acceptedAt: true, revokedAt: true,
            workspace: { select: { name: true } },
          },
        });
        if (!existing) throw new AppError("not_found", "That invitation no longer exists.");
        if (existing.acceptedAt) throw new AppError("conflict", "That invitation was already accepted.");
        if (existing.revokedAt) throw new AppError("conflict", "That invitation was revoked.");

        // Re-check the rank: the sender may have been demoted since.
        assertCanAssignRole(actor, existing.role);

        const invitation = await issueInvitation({
          workspaceId,
          email: existing.email,
          role: existing.role,
          invitedById: actor.identity.id,
        });

        await deliver({
          token: invitation.token,
          email: existing.email,
          inviterName: actor.identity.name,
          workspaceName: existing.workspace.name,
          role: existing.role,
        });

        await audit(actor, {
          workspaceId,
          action: "member.invite_resent",
          entityType: "invitation",
          entityId: invitation.id,
          summary: "Re-sent an invitation",
          metadata: { email: existing.email, supersededId: existing.id },
        });

        revalidatePathSafely("/settings/team");
        return { email: existing.email };
      },
    ),
  );
}

export async function revokeInvitation(
  input: z.input<typeof invitationSchema>,
): Promise<ActionResult<{ invitationId: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = invitationSchema.parse(input);
        const workspaceId = actor.workspaceId;

        // Scoped by workspace as well as id: an invitation id from another
        // tenant must not be revocable, even though revoking is destructive
        // only to the invitation itself.
        const updated = await db.workspaceInvitation.updateMany({
          where: { id: data.invitationId, workspaceId, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: actor.identity.id },
        });
        if (updated.count === 0) {
          throw new AppError("not_found", "That invitation is no longer outstanding.");
        }

        await audit(actor, {
          workspaceId,
          action: "member.invite_revoked",
          entityType: "invitation",
          entityId: data.invitationId,
          summary: "Revoked an invitation",
        });

        revalidatePathSafely("/settings/team");
        return { invitationId: data.invitationId };
      },
    ),
  );
}

/**
 * Accepts an invitation as the signed-in user.
 *
 * Not a `workspaceAction`: the caller is by definition not yet a member of the
 * workspace they are joining, so there is no membership to authorise against.
 * The token is the authorisation, and `redeemInvitation` re-checks every
 * condition — expiry, revocation, single use, and that the address matches —
 * inside the transaction that grants access.
 */
export async function acceptInvitation(
  token: string,
): Promise<ActionResult<{ workspaceId: string; workspaceName: string }>> {
  return guard(async () => {
    const actor = await requireActor();
    await enforceRateLimit("mutation", { user: actor.identity.id });

    const found = await lookupInvitation(token);
    if (!found.ok) {
      throw new AppError("not_found", "That invitation link is no longer valid.");
    }

    // The role offered must still be a role this build knows about. An
    // invitation naming one that has since been removed is refused rather than
    // silently downgraded to something the inviter never approved.
    if (!(ROLES as readonly string[]).includes(found.invitation.role)) {
      throw new AppError("validation", "That invitation is no longer valid.");
    }

    const result = await redeemInvitation(token, {
      id: actor.identity.id,
      email: actor.identity.email,
    });
    return finishAcceptance(result, actor);
  });
}

/**
 * Accepts an invitation the signed-in person was addressed by, without a token.
 *
 * Offered on the welcome screen. The identity is the proof here rather than the
 * link, which is why `acceptInvitationById` compares the address again before
 * granting anything.
 */
export async function acceptInvitationById(
  invitationId: string,
): Promise<ActionResult<{ workspaceId: string; workspaceName: string }>> {
  return guard(async () => {
    const actor = await requireActor();
    await enforceRateLimit("mutation", { user: actor.identity.id });
    const id = zId.parse(invitationId);

    const result = await redeemById(id, {
      id: actor.identity.id,
      email: actor.identity.email,
    });
    return finishAcceptance(result, actor);
  });
}

/**
 * What both acceptance paths do once the membership exists.
 *
 * Not inside a tenant context, deliberately: the audit row names a workspace
 * this person joined moments ago, and `recordAudit` opens its own context for
 * it. Running this inside an action wrapper's ambient transaction reused that
 * transaction's *empty* context instead, the audit INSERT was refused by RLS,
 * and — because a failed statement poisons a PostgreSQL transaction — the
 * user updates above it were rolled back on commit. Two bugs from one nesting.
 */
async function finishAcceptance(
  result: Awaited<ReturnType<typeof redeemInvitation>>,
  actor: { identity: { id: string; email: string } },
): Promise<ActionResult<{ workspaceId: string; workspaceName: string }>> {
  if (!result.ok) {
    if (result.reason === "email_mismatch") {
      throw new AppError(
        "forbidden",
        "This invitation was sent to a different email address. " +
          "Sign in with that address to accept it.",
      );
    }
    throw new AppError("not_found", "That invitation link is no longer valid.");
  }

  // The token was delivered to this address and can only be redeemed once, so
  // opening it proves control of the inbox exactly as a verification link does.
  // Marking the address verified here spares a new teammate being told to
  // confirm an email they just demonstrably received — it is the same evidence,
  // not a weaker one.
  await db.user.updateMany({
    where: { id: actor.identity.id, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });

  // Joining a workspace *is* finishing onboarding. Left unset, the account
  // would later be offered the setup flow whose whole purpose is to create the
  // workspace this person just avoided creating.
  await db.user.updateMany({
    where: { id: actor.identity.id, onboardedAt: null },
    data: { onboardedAt: new Date(), lastSeenAt: new Date() },
  });

  await recordAudit({
    workspaceId: result.workspaceId,
    actorId: actor.identity.id,
    actorEmail: actor.identity.email,
    action: "member.invite_accepted",
    entityType: "workspace",
    entityId: result.workspaceId,
    summary: `Joined ${result.workspaceName} as ${result.role}`,
    metadata: { role: result.role },
  });

  revalidateLayout();
  return {
    ok: true as const,
    data: { workspaceId: result.workspaceId, workspaceName: result.workspaceName },
  };
}

/**
 * Sends the message, and never lets a delivery failure undo the invitation.
 *
 * The row is already written when this runs. A provider outage should leave an
 * invitation that can be re-sent, not a half-created one — so the failure is
 * logged loudly and the action still succeeds.
 */
async function deliver(options: {
  token: string;
  email: string;
  inviterName: string | null;
  workspaceName: string;
  role: string;
}): Promise<void> {
  // `appOrigin()` and not `env.appUrl`: it validates that the origin is a
  // canonical public one, so a customer-facing link can never be a deployment
  // URL. There is a test asserting exactly that.
  const link = `${appOrigin()}/invite/${encodeURIComponent(options.token)}`;

  try {
    await sendMail({
      to: options.email,
      ...invitationEmail({
        link,
        inviterName: options.inviterName,
        workspaceName: options.workspaceName,
        roleLabel: WORKSPACE_ROLE.label(options.role, options.role),
        expiresInDays: Math.round(INVITATION_LIFETIME_MS / (24 * 60 * 60 * 1000)),
      }),
    });
  } catch (error) {
    log.error("invitation email failed to send", {
      // Never the token, and never the address at error level.
      workspace: options.workspaceName,
      error: String(error),
    });
  }
}
