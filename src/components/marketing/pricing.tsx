import * as React from "react";
import Link from "next/link";
import { Check, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PLANS, PLAN_ORDER } from "@/lib/plans";
import { cn } from "@/lib/utils";

const CADENCE_LABEL: Record<string, string> = {
  forever: "forever",
  month: "per month",
  once: "one time",
};

export function Pricing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {PLAN_ORDER.map((id) => {
        const plan = PLANS[id];
        const featured = id === "pro";

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
            {plan.cadence === "once" ? (
              <p className="mt-1.5 text-[12px] text-muted">
                About 18 months of Pro. After that it&apos;s free.
              </p>
            ) : plan.cadence === "month" ? (
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
                {id === "free" ? "Start free" : id === "pro" ? "Get Pro" : "Buy once"}
              </Link>
            </Button>

            <ul className="mt-6 space-y-2.5 border-t border-hairline pt-5">
              {plan.features.map((feature) => (
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
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-body">Bring your own model</h3>
      </div>
      <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">
        Tiny AI runs on Claude or OpenAI — add your API key and it uses your account, so there is no AI surcharge
        on your subscription. Without a key, Tiny CRM still scores every relationship, deal and project, finds
        duplicates and flags what has gone quiet, using its built-in reasoning engine.
      </p>
    </div>
  );
}
