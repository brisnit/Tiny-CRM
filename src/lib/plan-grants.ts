import "server-only";

import { combinePlans, storedPlanId, type PlanId } from "@/lib/plans";

/**
 * Complimentary access, as the rest of the application sees it.
 *
 * ## Expiry is resolved on read, never by a job
 *
 * `activeGrantWhere()` compares `expiresAt` in the query that loads the grant,
 * so an expired grant stops applying the moment it lapses. There is no sweeper
 * to schedule, fail silently, or forget on a new environment — and no window in
 * which a lapsed grant is still honoured because the job has not run yet. The
 * cost is one predicate on a lookup that was already happening.
 *
 * ## Why a shared loader rather than resolution in one place
 *
 * Loading the effective plan inside `getIdentity()` covers the *acting user*,
 * and that is not the whole question. Three entitlement checks read a
 * **workspace owner's** plan instead, because the owner is who pays:
 * `fileUploadsIncluded`, `documentQaEntitled` and the seat limits. An actor-only
 * resolution would leave a complimentary Pro owner's workspace still refused
 * document questions, which is the bug this file exists to make impossible.
 *
 * So the shape every caller uses is the same: select the user's live grants
 * alongside whatever else is being read, then fold them in with `effectiveFrom`.
 */

/** A grant as loaded for entitlement decisions. */
export type LoadedGrant = {
  id: string;
  plan: string;
  reason: string;
  expiresAt: Date | null;
};

/** What an entitlement decision needs to know about one account. */
export type EffectiveEntitlement = {
  /** The raw `User.plan` column, unresolved. What Stripe owns. */
  stored: string;
  /** The alias-resolved underlying plan — Stripe-backed or legacy. */
  underlying: PlanId;
  /** The active grant's plan, or null. */
  granted: PlanId | null;
  /** What limits and capabilities resolve from. */
  effective: PlanId;
  /** The grant itself, for display and for the admin panel. */
  grant: LoadedGrant | null;
};

/**
 * The `where` for a grant that is in force right now.
 *
 * Exported so every caller filters identically. A caller that wrote its own
 * predicate and forgot `revokedAt` would honour a revoked grant, which is the
 * other half of the same mistake expiry makes.
 */
export function activeGrantWhere(now: Date = new Date()) {
  return {
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/** The Prisma `select` for grants, for embedding in an existing query. */
export const GRANT_SELECT = {
  id: true,
  plan: true,
  reason: true,
  expiresAt: true,
} as const;

/**
 * Folds a stored plan and its live grants into one answer.
 *
 * Takes grants as an array because callers embed `take: N` rather than
 * assuming one: nothing in the schema prevents two live grants, and silently
 * reading whichever came back first would make entitlement depend on row
 * order. The strongest is chosen explicitly.
 */
export function effectiveFrom(
  stored: string | null | undefined,
  grants: LoadedGrant[],
): EffectiveEntitlement {
  const underlying = storedPlanId(stored);

  let best: LoadedGrant | null = null;
  let bestPlan: PlanId | null = null;
  for (const candidate of grants) {
    const plan = storedPlanId(candidate.plan);
    // A grant naming a plan this build does not know resolves to `free` and is
    // ignored rather than guessed at.
    if (plan === "free") continue;
    if (!bestPlan || combinePlans(bestPlan, plan) === plan) {
      best = candidate;
      bestPlan = plan;
    }
  }

  const effective = combinePlans(underlying, bestPlan);
  // A grant that lost to the underlying plan is not *in force*, and saying so
  // keeps the panel honest: "complimentary Plus" on a Pro account would claim
  // an effect it is not having.
  const inForce = bestPlan !== null && effective === bestPlan && effective !== underlying;

  return {
    stored: stored ?? "free",
    underlying,
    granted: bestPlan,
    effective,
    grant: inForce ? best : null,
  };
}
