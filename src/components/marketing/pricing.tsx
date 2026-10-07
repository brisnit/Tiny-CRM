import * as React from "react";
import Link from "next/link";
import { Check, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PLANS, PLAN_ORDER, advertisedFeatures } from "@/lib/plans";
import { advertisedFlags } from "@/lib/documents/gate";
import { cn } from "@/lib/utils";

const CADENCE_LABEL: Record<string, string> = {
  forever: "forever",
  month: "per month",
  // Only reachable through a legacy plan, which this component never renders —
  // PLAN_ORDER contains the purchasable plans only.
  once: "one time",
};

export async function Pricing({ signedIn }: { signedIn: boolean }) {
  // Read globally — the pricing page has no workspace. A capability still dark
  // behind its flag is not advertised, so the promise and the product ship
  // together. There is no workspace-scoped override to consider here, and a
  // public page must not be able to read one.
  const enabledFlags = await advertisedFlags();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {PLAN_ORDER.map((id) => {
        const plan = PLANS[id];
        const featured = id === "plus";

        return (
          <div
            key={id}
            className={cn(
              "relative flex flex-col rounded-2xl border bg-panel p-6",
              featured
                ? "border-brand-500 shadow-pop lg:-my-2 lg:py-8"
                : "border-hairline",
            )}
          >
            {plan.highlight ? (
              <span
                className={cn(
                  "absolute -top-2.5 left-6 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                  featured
                    ? "bg-brand-500 text-white"
                    : "bg-sunken text-muted ring-1 ring-hairline",
                )}
              >
                {plan.highlight}
              </span>
            ) : null}

            <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-body">{plan.name}</h3>
            <p className="mt-1 text-[13px] text-muted">{plan.tagline}</p>

            <div className="mt-5 flex items-baseline gap-1.5">
              <span className="text-[34px] font-semibold leading-none tracking-[-0.03em] text-body tabular">
                ${(plan.priceCents / 100).toLocaleString()}
              </span>
              <span className="text-[13px] text-faint">{CADENCE_LABEL[plan.cadence]}</span>
            </div>
            {plan.cadence === "month" ? (
              <p className="mt-1.5 text-[12px] text-muted">Cancel any time. No contract.</p>
            ) : (
              <p className="mt-1.5 text-[12px] text-muted">No card. No trial clock.</p>
            )}

            <Button
              asChild
              variant={featured ? "brand" : "outline"}
              size="lg"
              className="mt-5 w-full"
            >
              <Link href={signedIn ? "/settings/billing" : (`/signup?plan=${id}` as never)}>
                {id === "free" ? "Start free" : `Get ${plan.name}`}
              </Link>
            </Button>

            <ul className="mt-6 space-y-2.5 border-t border-hairline pt-5">
              {/* Deliberately no period. This page describes the plan, not this
                  month, and it has no meter beside it to contradict. It therefore
                  shows the standing allowance — understating October's
                  grandfathered figure rather than baking a transitional number
                  into a page that may be cached past the month it described. */}
              {advertisedFeatures(plan, enabledFlags).map((feature) => (
                <li key={feature} className="flex items-start gap-2.5 text-[13px] leading-snug text-body">
                  <Check
                    className={cn("mt-0.5 size-4 shrink-0", featured ? "text-brand-500" : "text-brand-400")}
                  />
                  {feature}
                </li>
              ))}
            </ul>

            {id === "free" ? (
              <p className="mt-5 border-t border-hairline pt-4 text-[12px] leading-relaxed text-faint">
                Free accounts are capped, not crippled — every feature works, you just hit a ceiling as you grow.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AiCallout() {
  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 sm:p-8">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand-500 text-white">
          <Sparkles className="size-4" />
        </span>
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-body">
          Two kinds of intelligence, and only one is metered
        </h3>
      </div>
      <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">
        Tiny CRM scores every relationship, tracks deal momentum and project health, finds duplicates
        and flags what has gone quiet — all computed by the app itself. That is unlimited on every
        plan, including Free, and it needs no AI model at all.
      </p>
      <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">
        Asking Tiny a question in its own words calls a large language model, which costs real money
        per answer. That is what your monthly allowance covers. Run out and nothing breaks: the
        built-in engine keeps working and the allowance resets on the 1st.
      </p>
    </div>
  );
}
