import "server-only";

import { AppError } from "@/lib/errors";
import { assertTenantContext } from "@/lib/documents/gate";
import { requireFlag, isEnabled, type FlagKey } from "@/lib/flags";

/**
 * The gates in front of connecting a mailbox or a calendar.
 *
 * `integrations` — is live sync built and rolled out for this workspace?
 * plus the workspace owner's plan — has this account paid for it?
 *
 * Two different questions, kept apart for the reason set out at length in
 * src/lib/documents/gate.ts: a flag is an operator rollout control flipped one
 * workspace at a time, and a plan is an entitlement. Conflating them either
 * sells something still dark or gives a paid capability to everyone the moment
 * the flag flips.
 *
 * `assertTenantContext` is imported rather than re-implemented because the
 * hazard it guards is identical and has already cost this codebase three
 * production defects: `FeatureFlag` is workspace-scoped and under row-level
 * security, so a workspace override read with no tenant context is silently
 * filtered out and the built-in default is used instead — which for
 * `integrations` would mean a workspace that had been switched on quietly
 * behaving as though it had not.
 */

export const INTEGRATION_FLAGS = ["integrations"] as const satisfies readonly FlagKey[];

/**
 * Throws unless this workspace may connect a mailbox or calendar.
 *
 * Must be called inside a tenant context the caller has already earned from
 * their own memberships, not from a workspace id a browser supplied.
 */
export async function requireIntegrations(workspaceId: string): Promise<void> {
  assertTenantContext("requireIntegrations");
  for (const flag of INTEGRATION_FLAGS) {
    await requireFlag(flag, workspaceId);
  }
  await requireIntegrationEntitlement(workspaceId);
}

export async function requireIntegrationEntitlement(workspaceId: string): Promise<void> {
  if (await integrationsEntitled(workspaceId)) return;
  throw new AppError(
    "plan_limit",
    "Connecting email and calendar is a Pro feature. Nothing already imported is " +
      "removed, and you can still see it.",
  );
}

/**
 * Whether the workspace **owner's** plan includes sync.
 *
 * The owner's, not the caller's, for the same reason seats and document
 * questions read the owner: the capability belongs to the workspace and the
 * owner is who pays. Reading the caller's plan would refuse a Free member of a
 * Pro workspace and admit a Pro member of a Free one.
 *
 * Complimentary grants are resolved on this read through `activeGrantWhere()`,
 * so a grant that expired an hour ago stops permitting new connections now
 * rather than at the next scheduled job.
 */
export async function integrationsEntitled(workspaceId: string): Promise<boolean> {
  const { db } = await import("@/lib/db");
  const { planGrants } = await import("@/lib/plans");
  const { activeGrantWhere, effectiveFrom, GRANT_SELECT } = await import("@/lib/plan-grants");

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      owner: {
        select: {
          plan: true,
          planGrants: { where: activeGrantWhere(), take: 5, select: GRANT_SELECT },
        },
      },
    },
  });

  // A workspace this context cannot see is not entitled. Failing closed,
  // because the alternative is granting a paid capability on an empty read.
  if (!workspace) return false;
  const effective = effectiveFrom(workspace.owner.plan, workspace.owner.planGrants).effective;
  return planGrants(effective, "emailCalendarSync");
}

/**
 * The same question as a decision rather than a refusal, for a page choosing
 * whether to offer a Connect button or a background job choosing to skip work.
 */
export async function integrationsEnabled(workspaceId: string): Promise<boolean> {
  assertTenantContext("integrationsEnabled");
  for (const flag of INTEGRATION_FLAGS) {
    if (!(await isEnabled(flag, workspaceId))) return false;
  }
  return integrationsEntitled(workspaceId);
}

/**
 * Whether sync may be *advertised* — on the public pricing page, which has no
 * workspace at all.
 *
 * Read globally and deliberately so: a public page must not be able to read a
 * tenant's flag row, and one workspace's override must not change what everyone
 * is promised. Being global, there is no override for RLS to filter, which is
 * why this is the one read here that needs no tenant context.
 */
export async function integrationsAdvertised(): Promise<boolean> {
  return isEnabled("integrations", null);
}
