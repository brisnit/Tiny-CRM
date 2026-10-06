import { AlertTriangle, CalendarClock, Check, Sparkles, Zap } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { Progress } from "@/components/ui/controls";
import { Badge } from "@/components/ui/badge";
import { PlanPicker } from "@/components/app/plan-picker";
import { requireActor } from "@/lib/auth/access";
import { currentPeriod } from "@/lib/dates";
import { getPlanUsage } from "@/lib/entitlements";
import {
  ENFORCED_LIMITS,
  LIMIT_NOUN_PLURAL,
  LIMIT_SCOPE,
  UNLIMITED,
  advertisedFeatures,
  aiAllowanceFor,
  planFor,
  type LimitKey,
} from "@/lib/plans";
import { advertisedFlags } from "@/lib/documents/gate";
import { db } from "@/lib/db";
import { stripeConfigured, stripeMode } from "@/lib/env";
import { formatDate } from "@/lib/dates";

export const metadata = { title: "Plan & billing" };

/**
 * `seats` is not shown here even though it is enforced: it is the one per-workspace
 * limit, so a single account-wide number would be wrong. It belongs on the team
 * screen, next to the members it counts.
 */
const TRACKED: LimitKey[] = ENFORCED_LIMITS.filter((k) => k !== "seats" && k !== "aiRequestsPerMonth");

export default async function BillingSettings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const actor = await requireActor();
  const [usage, account] = await Promise.all([
    getPlanUsage(actor),
    db.user.findUniqueOrThrow({
      where: { id: actor.identity.id },
      select: { plan: true, planStatus: true, planRenewsAt: true, billingCustomerId: true },
    }),
  ]);

  const plan = planFor(account.plan);
  // Resolved globally, like the public pricing page: a capability still behind
  // its rollout flag is not listed as something this plan includes.
  const enabledFlags = await advertisedFlags();
  // Effective, not standing — see aiAllowanceFor. The gauge and the enforcement
  // path must never print different ceilings.
  const aiLimit = aiAllowanceFor(plan, currentPeriod());
  const aiUsed = usage.aiRequestsPerMonth;
  const aiPct = aiLimit === UNLIMITED ? 0 : Math.min(100, Math.round((aiUsed / aiLimit) * 100));

  // `checkout=complete` is a hint for copy only. Everything rendered below comes
  // from the stored plan, which only the Stripe webhook can change — so someone
  // who types this parameter sees their real plan, not an upgrade.
  const justCheckedOut = params.checkout === "complete";
  const pastDue = account.planStatus === "past_due";
  // Stripe reports a cancelled-but-still-paid subscription as active with
  // cancel_at_period_end, which the webhook stores as "canceling". Without this
  // distinction the panel below rendered "Renews <date>" for a date on which the
  // plan will in fact end — telling someone who had just cancelled the opposite
  // of what they asked for.
  const canceling = account.planStatus === "canceling";

  return (
    <div className="space-y-5">
      {justCheckedOut && !plan.purchasable ? null : justCheckedOut ? (
        <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4 text-[13px] text-body dark:border-brand-900 dark:bg-brand-950/40">
          <strong className="font-semibold">Thanks — payment received.</strong> Your plan updates as
          soon as Stripe confirms it, usually within a few seconds. Reload if this still shows your
          old plan.
        </div>
      ) : null}

      {pastDue ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50/70 p-4 text-[13px] text-body dark:border-amber-900 dark:bg-amber-950/40">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <strong className="font-semibold">Your last payment did not go through.</strong> Nothing
            has been removed and your data is untouched — Stripe is retrying the card. Update your
            payment method below to avoid losing access.
          </div>
        </div>
      ) : null}

      {canceling ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-hairline bg-sunken/60 p-4 text-[13px] text-body">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" />
          <div>
            <strong className="font-semibold">Your subscription is cancelled.</strong> You keep{" "}
            {plan.name} until{" "}
            {account.planRenewsAt ? formatDate(account.planRenewsAt) : "the end of this billing period"},
            because that period is already paid for. After that this account moves to Free. Nothing is
            deleted — limits apply to creating more, not to what you already have. You can resume any
            time from the billing portal below.
          </div>
        </div>
      ) : null}

      <Panel>
        <PanelHeader
          title="Your plan"
          description={
            !plan.purchasable
              ? "An original plan. Unchanged by current pricing."
              : plan.priceCents === 0
                ? "Free forever, with limits"
                : canceling
                  ? account.planRenewsAt
                    ? `Cancelled — ends ${formatDate(account.planRenewsAt)}`
                    : "Cancelled — ends at the close of this billing period"
                  : account.planRenewsAt
                    ? `Renews ${formatDate(account.planRenewsAt)}`
                    : "Active"
          }
          icon={<Zap />}
          action={
            <Badge tone="bg-brand-50 text-brand-800 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-900">
              {plan.name}
            </Badge>
          }
        />
        <div className="border-t border-hairline p-4">
          <ul className="grid gap-2 sm:grid-cols-2">
            {/* The period matters here: this list sits directly above the usage
                meter, and without it the copy stated the standing allowance while
                the meter counted the effective one — "10 Tiny AI model answers a
                month" above "Model answers 7 / 25" during the October cutover. */}
            {advertisedFeatures(plan, enabledFlags, currentPeriod()).map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-[13px] text-body">
                <Check className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Tiny AI this month"
          description="Model answers count against your plan. Built-in insights never do."
          icon={<Sparkles />}
        />
        <div className="border-t border-hairline p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-body">Model answers</span>
            <span
              className={`text-[12.5px] tabular ${aiPct >= 80 ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted"}`}
            >
              {aiLimit === UNLIMITED
                ? `${aiUsed.toLocaleString()} · unlimited`
                : `${aiUsed.toLocaleString()} / ${aiLimit.toLocaleString()}`}
            </span>
          </div>
          {aiLimit !== UNLIMITED ? (
            <Progress
              value={aiPct}
              className="mt-1.5"
              barClassName={aiPct >= 80 ? "bg-amber-500" : undefined}
            />
          ) : null}
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            Relationship scores, deal momentum, project health, duplicate detection, the hygiene
            checks and the daily brief are computed by Tiny CRM itself. They are unlimited on every
            plan, including Free, and they keep working after this allowance runs out. The allowance
            resets on the 1st.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Usage"
          description="Counted across every workspace on your account"
        />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {TRACKED.map((key) => {
            const limit = plan.limits[key];
            const used = usage[key];
            const unlimited = limit === UNLIMITED;
            const pct = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
            const near = !unlimited && pct >= 80;

            return (
              <li key={key} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-body">
                    <span className="capitalize">{LIMIT_NOUN_PLURAL[key]}</span>
                    {LIMIT_SCOPE[key] === "workspace" ? (
                      <span className="ml-1.5 text-[11px] text-faint">per workspace</span>
                    ) : null}
                  </span>
                  <span
                    className={`text-[12.5px] tabular ${near ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted"}`}
                  >
                    {unlimited
                      ? `${used.toLocaleString()} · unlimited`
                      : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
                  </span>
                </div>
                {!unlimited ? (
                  <Progress
                    value={pct}
                    className="mt-1.5"
                    barClassName={near ? "bg-amber-500" : undefined}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel>
        <PanelHeader title="Change plan" description="Upgrade, downgrade or cancel" />
        <div className="border-t border-hairline p-4">
          <PlanPicker
            current={plan.id}
            canCheckout={stripeConfigured()}
            hasSubscription={Boolean(account.billingCustomerId)}
          />
          {stripeMode() === "test" ? (
            <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-[12px] leading-relaxed text-body dark:border-amber-900 dark:bg-amber-950/30">
              <strong className="font-semibold">Stripe is in test mode on this deployment.</strong>{" "}
              Checkout works end to end but no real card is charged.
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
