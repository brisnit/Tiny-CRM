import "server-only";

import { db } from "@/lib/db";
import { currentPeriod } from "@/lib/dates";
import { AppError } from "@/lib/errors";
import { LIMIT_NOUN, PLANS, PlanLimitError, UNLIMITED, limitFor, planFor, type LimitKey, type PlanId } from "@/lib/plans";
import type { Actor, WorkspaceActor } from "@/lib/auth/access";

/**
 * Entitlements.
 *
 * Plan limits are read from the *stored* plan on the user record, which only a
 * verified billing webhook can change (src/app/api/billing/webhook). Before the
 * hardening pass a `changePlan` server action let the browser assign its own
 * plan, so every limit below could be lifted for free — see F-04.
 *
 * Enforcement is server-side and unconditional: `assertWithinLimit` runs inside
 * the action, after authorization and before the write.
 */

export type Entitlements = {
  plan: PlanId;
  limits: (typeof PLANS)[PlanId]["limits"];
  canCreateWorkspace: boolean;
  canUseAi: boolean;
  canCreateAutomation: boolean;
  canInviteUsers: boolean;
  seats: number;
};

export async function getEntitlements(actor: Actor): Promise<Entitlements> {
  const plan = planFor(actor.identity.plan);
  const usage = await getPlanUsage(actor);

  const within = (key: LimitKey) => {
    const limit = plan.limits[key];
    return limit === UNLIMITED || usage[key] < limit;
  };

  return {
    plan: plan.id,
    limits: plan.limits,
    canCreateWorkspace: within("workspaces"),
    canUseAi: within("aiRequestsPerMonth"),
    canCreateAutomation: within("automations"),
    canInviteUsers: plan.limits.seats > 1,
    seats: plan.limits.seats,
  };
}

/**
 * Counts current usage and throws if one more would exceed the plan.
 *
 * Counting spans every workspace the user belongs to, because the plan belongs
 * to the account rather than to a workspace.
 */
export async function assertWithinLimit(
  actor: Actor | WorkspaceActor,
  key: LimitKey,
  additional = 1,
): Promise<void> {
  const limit = limitFor(actor.identity.plan, key);
  if (limit === UNLIMITED) return;

  const usage = await getPlanUsage(actor);
  if (usage[key] + additional > limit) {
    throw new PlanLimitError(key, limit, (actor.identity.plan as PlanId) ?? "free");
  }
}

/** Current usage across every limited resource. */
export async function getPlanUsage(actor: Actor | WorkspaceActor): Promise<Record<LimitKey, number>> {
  const workspaceIds = actor.memberships.map((m) => m.id);
  const where = { workspaceId: { in: workspaceIds } };

  const [contacts, companies, deals, projects, opportunities, tasks, automations, savedViews, customFields, ai] =
    await Promise.all([
      db.contact.count({ where: { ...where, archivedAt: null } }),
      db.company.count({ where: { ...where, archivedAt: null } }),
      db.deal.count({ where: { ...where, archivedAt: null } }),
      db.project.count({ where: { ...where, archivedAt: null } }),
      db.opportunity.count({ where: { ...where, archivedAt: null } }),
      db.task.count({ where: { ...where, archivedAt: null } }),
      db.automation.count({ where }),
      db.savedView.count({ where: { userId: actor.identity.id } }),
      db.customFieldDef.count({ where }),
      db.usageCounter.findUnique({
        where: {
          userId_metric_period: {
            userId: actor.identity.id,
            metric: "ai_requests",
            period: currentPeriod(),
          },
        },
        select: { count: true },
      }),
    ]);

  return {
    workspaces: actor.memberships.length,
    contacts,
    companies,
    deals,
    projects,
    opportunities,
    tasks,
    automations,
    savedViews,
    customFields,
    aiRequestsPerMonth: ai?.count ?? 0,
    seats: 1,
  };
}

export async function recordUsage(userId: string, metric: string, amount = 1): Promise<void> {
  const period = currentPeriod();
  await db.usageCounter.upsert({
    where: { userId_metric_period: { userId, metric, period } },
    create: { userId, metric, period, count: amount },
    update: { count: { increment: amount } },
  });
}

/**
 * Applies a plan change. Callable only from the verified billing webhook and
 * from the development simulator — never from a browser-reachable action.
 */
export async function applyPlanChange(
  userId: string,
  plan: PlanId,
  options: { status?: string; renewsAt?: Date | null; customerId?: string | null } = {},
): Promise<void> {
  if (!PLANS[plan]) throw new AppError("validation", "Unknown plan.");
  await db.user.update({
    where: { id: userId },
    data: {
      plan,
      planStatus: options.status ?? "active",
      planRenewsAt: options.renewsAt ?? null,
      ...(options.customerId ? { billingCustomerId: options.customerId } : {}),
    },
  });
}

export { LIMIT_NOUN };
