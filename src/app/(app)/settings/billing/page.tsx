import { Check, Zap } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { Progress } from "@/components/ui/controls";
import { Badge } from "@/components/ui/badge";
import { PlanPicker } from "@/components/app/plan-picker";
import { requireUser, getPlanUsage } from "@/lib/auth/session";
import { LIMIT_NOUN, UNLIMITED, planFor, type LimitKey } from "@/lib/plans";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/dates";

export const metadata = { title: "Plan & billing" };

const TRACKED: LimitKey[] = [
  "workspaces", "contacts", "companies", "deals", "projects",
  "opportunities", "tasks", "aiRequestsPerMonth", "automations", "savedViews", "customFields",
];

export default async function BillingSettings() {
  const user = await requireUser();
  const [usage, account] = await Promise.all([
    getPlanUsage(user),
    db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { plan: true, planStatus: true, planRenewsAt: true },
    }),
  ]);

  const plan = planFor(account.plan);

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Your plan"
          description={
            plan.id === "lifetime"
              ? "Paid once. Yours permanently."
              : plan.id === "pro"
                ? account.planRenewsAt
                  ? `Renews ${formatDate(account.planRenewsAt)}`
                  : "Active"
                : "Free forever, with limits"
          }
          icon={<Zap />}
          action={<Badge tone="bg-brand-50 text-brand-800 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-900">{plan.name}</Badge>}
        />
        <div className="border-t border-hairline p-4">
          <ul className="grid gap-2 sm:grid-cols-2">
            {plan.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-[13px] text-body">
                <Check className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Usage" description="What you are using against your limits" />
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
                  <span className="text-[13px] capitalize text-body">
                    {LIMIT_NOUN[key]}
                    {key === "aiRequestsPerMonth" ? " requests" : "s"}
                  </span>
                  <span
                    className={`text-[12.5px] tabular ${near ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted"}`}
                  >
                    {unlimited ? `${used.toLocaleString()} · unlimited` : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
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
        <PanelHeader
          title="Change plan"
          description="Upgrade, downgrade, or buy it outright"
        />
        <div className="border-t border-hairline p-4">
          <PlanPicker current={plan.id} />
          <p className="mt-4 rounded-lg border border-hairline bg-sunken/50 p-3 text-[12px] leading-relaxed text-muted">
            <strong className="font-semibold text-body">No payment processor is connected.</strong>{" "}
            Changing a plan here updates your account immediately so limits and gating can be exercised
            end to end. The billing module is isolated behind a single function, so wiring a real checkout
            and webhook does not touch anything else in the app.
          </p>
        </div>
      </Panel>
    </div>
  );
}
