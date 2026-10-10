import "server-only";

import { isLegacyPlan, planFor, type PlanId } from "@/lib/plans";

/**
 * What we can honestly say about a customer's billing, from what we store.
 *
 * ## Why this is not just `User.plan`
 *
 * `User.plan` says what an account is entitled to. It does not say whether
 * anyone is being charged, and the two come apart in ways that matter to an
 * operator:
 *
 *   - **Legacy entitlements are not subscriptions.** A Lifetime account has
 *     `plan = "lifetime"` and no recurring charge at all. Labelling that
 *     "Paid: Legacy Lifetime" would state, on the screen used to answer
 *     billing questions, that somebody is paying monthly when they are not.
 *   - **A cancelled subscription leaves a customer id behind.** Stripe keeps
 *     the customer; the webhook sets the plan to `free`. "Paid: Free" is not
 *     a thing.
 *   - **A purchasable plan with a dead status is not live.** `canceled`,
 *     `unpaid`, `incomplete` and `paused` all mean nothing is being collected.
 *
 * So "paid" is claimed only where three things agree: the plan is one that is
 * actually sold, the stored status is one Stripe uses for a live
 * subscription, and a Stripe customer exists to carry it. Anything else is
 * reported as an **underlying plan** with its status shown separately, which
 * is a weaker claim and the only one the data supports.
 *
 * This reads the stored status rather than calling Stripe. That is a real
 * limit and it is stated on the page: the status is as of the last webhook.
 * Calling Stripe per row would turn a directory into a rate-limited fan-out,
 * and the dashboard link is there for the authoritative answer.
 */

/** Stripe statuses that mean money is still expected to arrive. */
const LIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  // Still live: Stripe is retrying the card and the customer usually does not
  // know yet. `entitlementFor` keeps the plan for the same reason.
  "past_due",
  // Cancelling at period end: paid for, and still running.
  "canceling",
]);

export type BillingState = {
  /** The resolved plan id behind `User.plan`. */
  plan: PlanId;
  /** The stored status, verbatim. */
  status: string;
  /** True only where a recurring Stripe subscription is actually indicated. */
  paidSubscription: boolean;
  /** True for a grandfathered entitlement that nobody is billed for. */
  legacy: boolean;
  /** What to put on the badge. */
  label: string;
  /** Long-form, for a tooltip. */
  detail: string;
};

export function billingStateFor(input: {
  storedPlan: string;
  planStatus: string;
  billingCustomerId: string | null;
}): BillingState {
  const plan = planFor(input.storedPlan).id;
  const legacy = isLegacyPlan(plan);
  const purchasable = planFor(input.storedPlan).purchasable && plan !== "free";
  const live = LIVE_SUBSCRIPTION_STATUSES.has(input.planStatus);
  const paidSubscription = purchasable && live && Boolean(input.billingCustomerId);

  if (legacy) {
    return {
      plan,
      status: input.planStatus,
      paidSubscription: false,
      legacy: true,
      label: `Legacy: ${titleise(plan)}`,
      detail:
        `A grandfathered entitlement, not a recurring subscription. ` +
        `No Stripe charge is associated with it.`,
    };
  }

  if (paidSubscription) {
    return {
      plan,
      status: input.planStatus,
      paidSubscription: true,
      legacy: false,
      label: `Paid: ${titleise(plan)}`,
      detail: `Stripe subscription, status "${input.planStatus}" as of the last webhook.`,
    };
  }

  return {
    plan,
    status: input.planStatus,
    paidSubscription: false,
    legacy: false,
    label: `Underlying: ${titleise(plan)}`,
    detail:
      input.billingCustomerId
        ? `A Stripe customer exists but no live subscription is indicated ` +
          `(status "${input.planStatus}" as of the last webhook).`
        : `No Stripe customer. This account has never transacted.`,
  };
}

export function titleise(plan: string): string {
  return plan
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
