"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check } from "lucide-react";

import { moveDealToStage } from "@/lib/actions/deals";
import { moveOpportunityToStage } from "@/lib/actions/opportunities";
import { useSyncedState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

type Stage = { id: string; name: string; color: string; kind: string; probability: number };

/**
 * The stage rail on a record page — a horizontal progress bar you can click.
 * Faster than a dropdown for the one field that changes most often.
 */
export function StageSelector({
  dealId,
  opportunityId,
  currentStageId,
  stages,
}: {
  dealId?: string;
  opportunityId?: string;
  currentStageId: string;
  stages: Stage[];
}) {
  const router = useRouter();
  const [active, setActive] = useSyncedState(currentStageId);
  const [pending, startTransition] = React.useTransition();

  const currentIndex = stages.findIndex((s) => s.id === active);

  function move(stageId: string) {
    if (stageId === active) return;
    const previous = active;
    setActive(stageId);

    startTransition(async () => {
      const result = dealId
        ? await moveDealToStage(dealId, stageId)
        : await moveOpportunityToStage(opportunityId!, stageId);

      if (result.ok) {
        toast.success(`Moved to ${stages.find((s) => s.id === stageId)?.name}`);
        router.refresh();
      } else {
        setActive(previous);
        toast.error(result.error);
      }
    });
  }

  return (
    <div className={cn("flex flex-wrap gap-1", pending && "opacity-70")}>
      {stages.map((stage, index) => {
        const isActive = stage.id === active;
        const isPast = index < currentIndex;
        return (
          <button
            key={stage.id}
            onClick={() => move(stage.id)}
            disabled={pending}
            className={cn(
              "group relative inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              isActive
                ? "border-transparent text-white"
                : isPast
                  ? "border-hairline bg-sunken text-muted hover:bg-hairline"
                  : "border-hairline text-muted hover:bg-sunken hover:text-body",
            )}
            style={isActive ? { background: stage.color } : undefined}
            title={`${stage.name} — base win rate ${stage.probability}%`}
          >
            {isPast ? <Check className="size-3" /> : null}
            {stage.name}
          </button>
        );
      })}
    </div>
  );
}
