"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ExternalLink, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PLANS, PLAN_ORDER, type PlanId } from "@/lib/plans";
import { cn } from "@/lib/utils";

const CADENCE: Record<string, string> = { forever: "forever", month: "/month", once: "once" };

/**
 * Plan selection.
 *
 * This component no longer changes anything. The prototype called a
 * `changePlan` server action, which meant any user could grant themselves the
 * Lifetime plan from the browser (audit finding F-04). Entitlements now move
 * only through a signed billing webhook, so these buttons hand off to a checkout
 * URL and the plan updates when the provider confirms payment.
 */
export function PlanPicker({
  current,
  checkoutBaseUrl,
}: {
  current: PlanId;
  checkoutBaseUrl?: string | null;
}) {
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
              ) : checkoutBaseUrl ? (
                <Button asChild size="sm" variant={id === "free" ? "outline" : "brand"} className="mt-4 w-full">
                  <a href={`${checkoutBaseUrl}?plan=${id}`} target="_blank" rel="noreferrer">
                    {id === "free" ? "Downgrade" : "Continue to checkout"}
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="mt-4 w-full" disabled>
                  <Lock className="size-3.5" />
                  Checkout unavailable
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {!checkoutBaseUrl ? (
        <p className="rounded-lg border border-hairline bg-sunken/50 p-3 text-[12px] leading-relaxed text-muted">
          <strong className="font-semibold text-body">No payment provider is connected.</strong>{" "}
          Plans can only be changed by a signed webhook from a billing provider — the browser cannot
          modify entitlements. See{" "}
          <Link href="/settings/billing" className="text-brand-600 hover:underline dark:text-brand-400">
            docs/DEPLOYMENT-CHECKLIST.md
          </Link>{" "}
          for wiring one up.
        </p>
      ) : null}
    </div>
  );
}
