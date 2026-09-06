"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PLANS, PLAN_ORDER, type PlanId } from "@/lib/plans";
import { changePlan } from "@/lib/actions/settings";
import { cn } from "@/lib/utils";

const CADENCE: Record<string, string> = { forever: "forever", month: "/month", once: "once" };

export function PlanPicker({ current }: { current: PlanId }) {
  const router = useRouter();
  const { update } = useSession();
  const [pending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<PlanId | null>(null);

  function choose(plan: PlanId) {
    setTarget(plan);
    startTransition(async () => {
      const result = await changePlan(plan);
      if (result.ok) {
        toast.success(`Switched to ${PLANS[plan].name}`);
        // Refresh the JWT so the sidebar's plan badge updates without a re-login.
        await update();
        router.refresh();
      } else {
        toast.error(result.error);
      }
      setTarget(null);
    });
  }

  return (
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
            <Button
              size="sm"
              variant={active ? "subtle" : id === "free" ? "outline" : "brand"}
              className="mt-4 w-full"
              disabled={active}
              loading={pending && target === id}
              onClick={() => choose(id)}
            >
              {active ? "Current plan" : id === "free" ? "Downgrade" : "Switch"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
