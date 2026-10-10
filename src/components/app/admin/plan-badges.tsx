import { CreditCard, Gift, Landmark } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/**
 * What a customer is billed for, what they were given, and what applies.
 *
 * Three facts that are routinely conflated, shown as three things:
 *
 *   - **Billing.** "Paid" is claimed only where a live Stripe subscription is
 *     actually indicated — see `billingStateFor`. A legacy entitlement reads
 *     "Legacy", because nobody is charged for one and this is the screen
 *     people answer billing questions from. Everything else reads
 *     "Underlying", with the stored status beside it.
 *   - **Complimentary.** A grant. It creates no subscription and charges
 *     nothing, which the label says rather than implies. Shown **whenever one
 *     is live**, including when it is not currently adding anything — its
 *     expiry is the thing an operator needs to see in advance, and hiding it
 *     until it mattered would hide it exactly when there was still time.
 *   - **Effective.** What limits and capabilities resolve from. Shown only
 *     when it differs from the underlying plan, because a badge repeating the
 *     one beside it teaches the reader to stop reading.
 */
export function PlanBadges({
  billingLabel,
  billingDetail,
  billingKind,
  planStatus,
  underlyingPlan,
  effectivePlan,
  grant,
  grantInForce,
}: {
  billingLabel: string;
  billingDetail: string;
  billingKind: "paid" | "legacy" | "underlying";
  planStatus: string;
  underlyingPlan: string;
  effectivePlan: string;
  grant: { plan: string; reason: string; expiresAt: Date | null } | null;
  grantInForce: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <Badge tone={BILLING_TONE[billingKind]} title={billingDetail}>
        {billingKind === "paid" ? <CreditCard className="size-3" aria-hidden /> : null}
        {billingKind === "legacy" ? <Landmark className="size-3" aria-hidden /> : null}
        {billingLabel}
      </Badge>

      {/* The status, separately, whenever we are not claiming a live
          subscription — the weaker label is only honest with it beside. */}
      {billingKind !== "paid" && planStatus && planStatus !== "active" ? (
        <Badge title="Stored billing status, as of the last webhook">{planStatus}</Badge>
      ) : null}

      {grant ? (
        <Badge
          tone={
            grantInForce
              ? "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900"
              : undefined
          }
          title={
            `Complimentary ${titleise(grant.plan)} — ${grant.reason}. ` +
            `No Stripe subscription, no charge.` +
            (grant.expiresAt
              ? ` Expires ${grant.expiresAt.toISOString().slice(0, 10)}.`
              : " No expiry.") +
            (grantInForce
              ? ""
              : ` Not adding anything at the moment: the account's own plan already matches it.`)
          }
        >
          <Gift className="size-3" aria-hidden />
          Complimentary: {titleise(grant.plan)}
          {grant.expiresAt ? ` · to ${grant.expiresAt.toISOString().slice(0, 10)}` : " · no expiry"}
          {grantInForce ? "" : " (inactive)"}
        </Badge>
      ) : null}

      {effectivePlan !== underlyingPlan ? (
        <Badge
          tone="bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
          title="What limits and capabilities resolve from right now"
        >
          Effective: {titleise(effectivePlan)}
        </Badge>
      ) : null}
    </div>
  );
}

const BILLING_TONE: Record<string, string | undefined> = {
  paid: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900",
  legacy:
    "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900",
  underlying: undefined,
};

function titleise(plan: string): string {
  return plan
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
