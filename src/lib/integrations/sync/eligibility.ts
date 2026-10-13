import "server-only";

import { db } from "@/lib/db";
import { assertTenantContext } from "@/lib/documents/gate";
import { integrationsEnabled } from "@/lib/integrations/gate";

/**
 * May this connection still sync — not "was it allowed to connect".
 *
 * Everything that gates *connecting* is checked once, at the moment somebody
 * presses Connect: the `integrations` flag, the owner's plan, their session.
 * Nothing re-asked any of it afterwards. A connection made legitimately in
 * March kept importing in June regardless of what had changed, because the
 * only thing the sync path looked at was `Integration.status` — a column that
 * records what happened to the *connection*, and knows nothing about the
 * person, the workspace, the rollout or the plan.
 *
 * Four ways that goes wrong, none of them exotic:
 *
 *   * **The account is suspended.** `deactivatedAt` is documented as "checked
 *     on every request" — and a background job is not a request. An account an
 *     operator has disabled kept pulling its mailbox into the CRM.
 *   * **They were removed from the workspace.** Worse than merely continuing:
 *     `restrictedIdsFor` returns `[]` for somebody with no membership, and `[]`
 *     is the unrestricted value, so the import ran with a *wider* record scope
 *     than the member had when they left — and the contact matcher reads
 *     through it.
 *   * **The flag was switched off.** A rollout control that cannot stop work
 *     already in flight is not a rollout control. Switching `integrations` off
 *     for a workspace has to stop its syncing, or the only way to stop an
 *     import is to disconnect it on the customer's behalf.
 *   * **The plan no longer includes sync.** A Pro workspace that downgrades,
 *     or a complimentary grant that expires, keeps the capability it stopped
 *     paying for. `integrationsEntitled` resolves grants live for exactly this
 *     reason, and nothing was calling it.
 *
 * Checked in **two** places, and both are necessary. At scheduling, so nothing
 * new is queued; and again inside the job, because a job queued before the
 * change is already in the queue and a scheduling-time check cannot reach it.
 * The second is the one that actually holds: the window between queueing and
 * running is minutes wide and spans exactly the moment an operator suspends
 * an account.
 *
 * Fails closed. A read that comes back empty — because the row is gone, or
 * because a policy filtered it — is ineligible, never "probably fine".
 */

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: string; detail: string };

export async function syncEligibility(input: {
  workspaceId: string;
  ownerUserId: string;
}): Promise<Eligibility> {
  // The flag read is workspace-scoped and under row-level security, so a
  // context-less call silently reads the built-in default instead of the
  // workspace's override. Asserted rather than hoped for.
  assertTenantContext("syncEligibility");

  const owner = await db.user.findUnique({
    where: { id: input.ownerUserId },
    select: { deactivatedAt: true },
  });
  // Missing is ineligible. A deleted account, or one this context cannot
  // read, must not keep importing on the strength of an empty result.
  if (!owner) return { eligible: false, reason: "owner-missing", detail: "the account no longer exists" };
  if (owner.deactivatedAt) {
    return { eligible: false, reason: "owner-suspended", detail: "the account is suspended" };
  }

  const membership = await db.workspaceMember.findFirst({
    where: { workspaceId: input.workspaceId, userId: input.ownerUserId },
    select: { id: true },
  });
  if (!membership) {
    return {
      eligible: false,
      reason: "not-a-member",
      detail: "the account is no longer a member of this workspace",
    };
  }

  // Flag and plan together, which is what `integrationsEnabled` is: the
  // rollout control AND the owner's entitlement, resolved live so an expired
  // grant stops sync now rather than at some later checkpoint.
  if (!(await integrationsEnabled(input.workspaceId))) {
    return {
      eligible: false,
      reason: "not-enabled",
      detail: "email and calendar sync is not enabled for this workspace",
    };
  }

  return { eligible: true };
}
