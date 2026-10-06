import "server-only";

import { db } from "@/lib/db";
import { currentPeriod } from "@/lib/dates";
import { AppError } from "@/lib/errors";
import {
  AiAllowanceError, LIMIT_NOUN, PLANS, PlanLimitError, UNLIMITED,
  aiAllowanceFor, limitFor, planFor, type LimitKey, type PlanId,
} from "@/lib/plans";
import type { Actor, WorkspaceActor } from "@/lib/auth/access";
import { withTenantContext } from "@/lib/tenant-db";

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
    // The AI allowance is the one limit that can differ from the plan's standing
    // figure, during the pricing cutover period. Reading `plan.limits` directly
    // here would grey out Tiny AI for an account the reservation path would in
    // fact have served.
    const limit =
      key === "aiRequestsPerMonth" ? aiAllowanceFor(plan, currentPeriod()) : plan.limits[key];
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

/**
 * Throws unless the workspace's owner is on a plan that includes file uploads.
 *
 * ## Why this did not exist, and why it has to
 *
 * `PlanCapabilities.fileUploads` has been declared since the plan matrix was
 * written — `false` on Free, `true` on Plus and Pro — and **nothing ever read
 * it**. `planGrants` was only ever called for `documentQa`. The capability was
 * enforced by accident: the `files` feature flag defaults to `false` and is
 * enabled for one workspace, so nobody had uploads and the gap was invisible.
 *
 * It stops being invisible the moment `files` is turned on globally, which is
 * exactly what rolling this feature out involves. Without this check a Free
 * account would get a capability the pricing page sells as Plus, and the flag
 * that was supposed to be an operator rollout control would silently become a
 * pricing change.
 *
 * ## Whose plan
 *
 * The **workspace owner's**, like seats and like `documentQaEntitled` — the
 * capability belongs to the workspace and the owner is who pays for it. Reading
 * the caller's plan instead would refuse a Free member of a Plus workspace and
 * admit a Plus member of a Free one.
 *
 * ## Uploading only
 *
 * Called on the two upload steps and deliberately **not** on preview, download
 * or delete. An account that downgrades keeps what it already stored and must
 * still be able to read and remove it; a plan change is not a reason to hold
 * somebody's contracts hostage. This mirrors what the document-QA refusal
 * already promises in so many words: "Everything already uploaded stays where
 * it is, and you can still download it."
 *
 * Must be called inside a tenant context the caller has already earned.
 * `Workspace` is under row-level security, so a workspace that is not visible
 * from this context is not entitled — failing closed, because the alternative
 * is granting a paid capability because a read came back empty.
 */
export async function requireFileUploadEntitlement(workspaceId: string): Promise<void> {
  const { planGrants } = await import("@/lib/plans");

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { owner: { select: { plan: true } } },
  });

  if (workspace && planGrants(workspace.owner.plan, "fileUploads")) return;

  throw new AppError(
    "plan_limit",
    "Attaching files to a record is a Plus feature. Upgrade to upload documents.",
  );
}

/** Current usage across every limited resource. */
export async function getPlanUsage(actor: Actor | WorkspaceActor): Promise<Record<LimitKey, number>> {
  const workspaceIds = actor.memberships.map((m) => m.id);
  const where = { workspaceId: { in: workspaceIds } };

  // Plan limits are account-wide, so this counts across every workspace the
  // actor belongs to — wider than the single-workspace context a mutation runs
  // in, hence `isolated`. Without a context at all these counts came back zero
  // under RLS and the limits stopped being enforced entirely, which is the
  // wrong direction for a check whose job is to say no.
  // The one context that reads records and is still unrestricted, deliberately.
  // Plan usage is a property of the workspace, not a view of it: counting only
  // what a restricted member can see would under-report and quietly stop
  // enforcing the limit — a check whose job is to say no would start saying
  // yes. Deliberately NOT NO_RECORD_READS, which claims the opposite; these
  // rows are counted, never returned.
  return withTenantContext(
    { workspaceIds, userId: actor.identity.id, restrictedWorkspaceIds: [] },
    async () => {
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
  }, { isolated: true });
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
 * Claims one metered AI request, atomically, or refuses.
 *
 * ## Why this is not `assertWithinLimit` followed by `recordUsage`
 *
 * That pair is a read, a decision, and a write — three steps with gaps. Two
 * requests arriving together both read a count of 29 against a limit of 30, both
 * conclude they are within it, and both proceed. The allowance is a spending
 * limit on a paid API, so the gap is not a counting curiosity: it is the
 * difference between a bounded bill and an unbounded one, and it widens with
 * concurrency exactly when a user is most likely to be firing several questions
 * at once.
 *
 * The check and the increment are therefore one statement. `ON CONFLICT ... DO
 * UPDATE ... WHERE` is evaluated against the locked existing row, so a losing
 * concurrent writer updates nothing and gets no row back. No rows returned means
 * the allowance is spent. PostgreSQL and SQLite both implement this form, which
 * is why it is raw SQL rather than two Prisma calls.
 *
 * ## Why it reserves rather than records afterwards
 *
 * Reserving before the call means a request that is abandoned mid-flight has
 * still been paid for, which is the truth — an abandoned HTTP request to a model
 * provider is billed. Recording afterwards undercounts precisely the expensive
 * cases: a timeout, a dropped stream, a retried attempt.
 *
 * `UsageCounter` is deliberately outside RLS (see prisma/postgres/002), so this
 * needs no tenant context and cannot be made to return the wrong row by one.
 *
 * @returns true when the request may proceed and has been counted.
 */
export async function reserveAiRequest(
  userId: string,
  limit: number,
  metric = "ai_requests",
): Promise<boolean> {
  if (limit === UNLIMITED) {
    await recordUsage(userId, metric);
    return true;
  }
  if (limit <= 0) return false;

  const period = currentPeriod();
  const id = `usage_${userId}_${metric}_${period}`;

  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "UsageCounter" ("id", "userId", "metric", "period", "count", "updatedAt")
    VALUES (${id}, ${userId}, ${metric}, ${period}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "metric", "period") DO UPDATE
      SET "count" = "UsageCounter"."count" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "UsageCounter"."count" < ${limit}
    RETURNING "count"
  `;

  return rows.length > 0;
}

/**
 * Hands one reserved request back.
 *
 * Used only where it is certain no provider call was made — a capability refusal
 * decided after the reservation. Never on an error from the provider itself,
 * because that request was billed whatever it returned.
 */
export async function releaseAiRequest(userId: string, metric = "ai_requests"): Promise<void> {
  const period = currentPeriod();
  await db.$executeRaw`
    UPDATE "UsageCounter"
       SET "count" = "count" - 1, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "userId" = ${userId} AND "metric" = ${metric}
       AND "period" = ${period} AND "count" > 0
  `;
}

/**
 * Reserves a metered request for this actor against their plan allowance, or
 * throws AiAllowanceError.
 *
 * Call this only when a *paid* provider is about to be used. The built-in engine
 * must not pass through here: it makes no external request, so metering it spends
 * an allowance nobody was billed for and then the exhaustion removes a feature
 * that costs nothing to serve.
 */
export async function reserveAiOrThrow(actor: Actor | WorkspaceActor): Promise<void> {
  const plan = planFor(actor.identity.plan);
  // The effective allowance, not the plan's standing one: during the pricing
  // cutover period a Free account is measured against the allowance it accrued
  // the month under. The error carries the same number, so the message a user
  // sees is the number that refused them.
  const limit = aiAllowanceFor(plan, currentPeriod());
  const ok = await reserveAiRequest(actor.identity.id, limit);
  if (!ok) throw new AiAllowanceError(limit, plan.id);
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
