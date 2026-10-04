"use client";

import * as React from "react";
import { CreditCard, Check, ExternalLink, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { openBillingPortal, startCheckout } from "@/lib/actions/billing";
import { PLANS, PLAN_ORDER, type PlanId } from "@/lib/plans";
import { cn } from "@/lib/utils";

const CADENCE: Record<string, string> = { forever: "forever", month: "/month", once: "once" };

/**
 * Plan selection.
 *
 * This component still changes nothing on its own. The prototype called a
 * `changePlan` server action, which meant any user could grant themselves the
 * top plan from the browser (audit finding F-04). What the buttons do now is ask
 * the server for a Stripe URL and follow it; the plan moves only when Stripe's
 * verified webhook says a payment happened.
 *
 * Someone already subscribed gets the Customer Portal rather than a second
 * checkout — upgrading, downgrading and cancelling all belong to Stripe, which
 * owns proration and dunning. Offering our own "switch plan" button here would
 * mean a second implementation that has to agree with Stripe's arithmetic.
 */
export function PlanPicker({
  current,
  canCheckout,
  hasSubscription,
}: {
  current: PlanId;
  /** False when the deployment has no Stripe configuration at all. */
  canCheckout: boolean;
  /** True once a Stripe customer exists, so the portal has something to show. */
  hasSubscription: boolean;
}) {
  const [busy, setBusy] = React.useState<PlanId | "portal" | null>(null);

  const legacy = !PLANS[current]?.purchasable;

  async function go(plan: PlanId) {
    setBusy(plan);
    try {
      const result = await startCheckout(plan);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // A full navigation, not a router push: the destination is Stripe.
      window.location.href = result.data.url;
    } finally {
      setBusy(null);
    }
  }

  async function portal() {
    setBusy("portal");
    try {
      const result = await openBillingPortal();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      window.location.href = result.data.url;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          const active = id === current;

          return (
            <div
              key={id}
              className={cn(
                "flex flex-col rounded-xl border p-4",
                active ? "border-brand-500 bg-brand-50/40 dark:bg-brand-950/30" : "border-hairline",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[13.5px] font-semibold text-body">{plan.name}</h4>
                {active ? <Check className="size-4 text-brand-500" /> : null}
              </div>
              <p className="mt-1 text-[12px] text-muted">{plan.tagline}</p>
              <p className="mt-3 text-[22px] font-semibold leading-none tracking-[-0.02em] tabular text-body">
                ${(plan.priceCents / 100).toLocaleString()}
                <span className="ml-1 text-[12px] font-normal text-faint">{CADENCE[plan.cadence]}</span>
              </p>

              {active ? (
                <Button size="sm" variant="subtle" className="mt-4 w-full" disabled>
                  Current plan
                </Button>
              ) : legacy ? (
                // A legacy plan holder must not be able to buy their way into a
                // *smaller* entitlement by accident. The server refuses this too.
                <Button size="sm" variant="outline" className="mt-4 w-full" disabled>
                  <Lock className="size-3.5" />
                  Contact us
                </Button>
              ) : !canCheckout ? (
                <Button size="sm" variant="outline" className="mt-4 w-full" disabled>
                  <Lock className="size-3.5" />
                  Checkout unavailable
                </Button>
              ) : id === "free" ? (
                // Downgrading to Free means cancelling, which is the portal's job.
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4 w-full"
                  disabled={!hasSubscription || busy !== null}
                  onClick={portal}
                >
                  {busy === "portal" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Cancel subscription
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="brand"
                  className="mt-4 w-full"
                  disabled={busy !== null}
                  onClick={() => go(id)}
                >
                  {busy === id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="size-3.5" />
                  )}
                  {hasSubscription ? `Switch to ${plan.name}` : `Get ${plan.name}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {hasSubscription && canCheckout ? (
        <Button variant="outline" size="sm" onClick={portal} disabled={busy !== null}>
          {busy === "portal" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CreditCard className="size-3.5" />
          )}
          Manage payment method and invoices
        </Button>
      ) : null}

      {legacy ? (
        <p className="rounded-lg border border-hairline bg-sunken/50 p-3 text-[12px] leading-relaxed text-muted">
          <strong className="font-semibold text-body">You are on an original plan.</strong>{" "}
          Everything you had is unchanged, and it is not affected by current pricing. Get in touch
          before switching so your existing access is not reduced.
        </p>
      ) : !canCheckout ? (
        <p className="rounded-lg border border-hairline bg-sunken/50 p-3 text-[12px] leading-relaxed text-muted">
          <strong className="font-semibold text-body">Checkout is not configured here.</strong>{" "}
          Plans can only change through a verified webhook from Stripe — the browser cannot modify
          entitlements. See docs/DEPLOYMENT-CHECKLIST.md for the variables this needs.
        </p>
      ) : null}
    </div>
  );
}
