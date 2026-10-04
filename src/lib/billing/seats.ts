import "server-only";

import { db } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-db";
import { AppError } from "@/lib/errors";
import { planFor } from "@/lib/plans";

/**
 * Seats: the one per-workspace limit.
 *
 * Every other limit is account-wide, because the plan lives on `User`. Seats
 * cannot be, because a seat is a place in a *workspace* — so the governing plan
 * is the **workspace owner's**, not the invitee's and not the inviter's. The
 * person paying for the workspace is the person whose ceiling applies.
 *
 * ## Why this file exists at all
 *
 * "Up to 5 seats" was on the pricing page for the whole of the previous plan
 * generation and was never enforced anywhere. `getEntitlements` computed a
 * `canInviteUsers` flag and had zero callers; no invitation path consulted a seat
 * count. Advertising a limit nobody checks is worse than having no limit: it
 * tells customers the product does something it does not, and it means the first
 * time the number matters is during an argument about a bill.
 *
 * ## Where the check belongs
 *
 * At **acceptance**, because that is where a member row is created, and it is the
 * only point that cannot be bypassed — an invitation can be issued, forwarded and
 * accepted much later, by which time the seat situation has changed. Issuing is
 * also checked, but only so an admin gets the refusal while they are still
 * looking at the invite form rather than after someone else has clicked a link.
 */

export type SeatUsage = {
  workspaceId: string;
  /** Members currently in the workspace. */
  used: number;
  /** The seat ceiling from the owner's plan. */
  limit: number;
  /** Outstanding invitations that have not been accepted or revoked. */
  pending: number;
  ownerPlan: string;
};

/**
 * Counts seats in a workspace against its owner's plan.
 *
 * Reads the owner and the member count outside any tenant context on purpose:
 * this is a property *of* the workspace, like plan usage in
 * src/lib/entitlements.ts, not a view of it. Counting only what the caller can
 * see would under-report and let a restricted member invite past the ceiling —
 * a check whose job is to say no would start saying yes.
 */
export async function seatUsage(workspaceId: string): Promise<SeatUsage> {
  // Opens its own tenant context, scoped to exactly the workspace it was asked
  // about.
  //
  // `Workspace`, `WorkspaceMember` and `WorkspaceInvitation` are all under
  // row-level security. Read with no context they return nothing — so the first
  // version of this function reported every workspace as empty on PostgreSQL and
  // threw on the owner lookup, while passing on SQLite, which has no policies.
  // That is the same class of defect the flag-context tripwire exists for, and it
  // is why `assertSeatAvailable` must never be called outside one.
  //
  // Opening a context here is the right move rather than a shortcut, for the same
  // reason `getPlanUsage` does it in src/lib/entitlements.ts: this is not an
  // authorisation check. The caller has already earned the workspace. This counts
  // a property *of* the workspace, and it must see all of it — counting only what
  // a restricted member can see would under-report and let them invite past the
  // ceiling, so a check whose job is to say no would start saying yes.
  //
  // `isolated` because the span is wider than the caller's own transaction, and
  // `restrictedWorkspaceIds: []` deliberately: no record-level narrowing applies
  // to a count that is never returned as rows.
  return withTenantContext(
    { workspaceIds: [workspaceId], userId: null, restrictedWorkspaceIds: [] },
    async () => {
      const workspace = await db.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { id: true, owner: { select: { plan: true } } },
      });

      const [used, pending] = await Promise.all([
        db.workspaceMember.count({ where: { workspaceId } }),
        db.workspaceInvitation.count({
          where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ]);

      const plan = planFor(workspace.owner.plan);

      return {
        workspaceId,
        used,
        pending,
        limit: plan.limits.seats,
        ownerPlan: plan.id,
      };
    },
    { isolated: true },
  );
}

/**
 * Throws when a workspace has no room for another member.
 *
 * `countPending` is on for the issuing check and off for the acceptance check,
 * and the asymmetry is deliberate. When issuing, outstanding invitations should
 * count — otherwise ten invitations can be sent into three seats and nine people
 * meet a refusal after accepting, which is a worse experience than the inviter
 * being told now. When accepting, they must not: the invitation being accepted is
 * itself pending, so counting it would make the last seat permanently
 * unreachable.
 */
export async function assertSeatAvailable(
  workspaceId: string,
  options: { countPending?: boolean } = {},
): Promise<SeatUsage> {
  const usage = await seatUsage(workspaceId);
  if (usage.limit === Number.POSITIVE_INFINITY) return usage;

  const taken = usage.used + (options.countPending ? usage.pending : 0);

  if (taken >= usage.limit) {
    const plan = planFor(usage.ownerPlan);
    throw new AppError(
      "plan_limit",
      options.countPending && usage.pending > 0
        ? `This workspace is on the ${plan.name} plan, which allows ${usage.limit} ` +
            `${usage.limit === 1 ? "person" : "people"}. It already has ${usage.used} ` +
            `and ${usage.pending} invitation${usage.pending === 1 ? "" : "s"} outstanding. ` +
            `Revoke an invitation or upgrade to add more.`
        : `This workspace is on the ${plan.name} plan, which allows ${usage.limit} ` +
            `${usage.limit === 1 ? "person" : "people"}. Upgrade to add more.`,
    );
  }

  return usage;
}
