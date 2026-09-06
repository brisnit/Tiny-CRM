"use client";

import * as React from "react";
import { Info, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ScoreFactor = { label: string; detail: string; impact: number };

/**
 * Every computed score can explain itself. That is the difference between a
 * number the user trusts and a number they ignore — so the factor list is a
 * first-class part of the UI, not a debugging aid.
 */
export function ScoreExplainer({
  label,
  tone,
  score,
  summary,
  factors,
  caption = "How this was calculated",
}: {
  label: string;
  tone: string;
  score: number;
  summary: string;
  factors: ScoreFactor[];
  caption?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1 rounded-md transition-opacity hover:opacity-80">
        <Badge tone={tone}>{label}</Badge>
        <Info className="size-3 text-faint" />
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-semibold text-body">{label}</span>
          <span className="text-[12px] text-faint tabular">{score}/100</span>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted">{summary}</p>

        <div className="mt-3 border-t border-hairline pt-2.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{caption}</p>
          <ul className="space-y-2">
            {factors.map((factor, i) => {
              const Icon = factor.impact > 0 ? TrendingUp : factor.impact < 0 ? TrendingDown : Minus;
              return (
                <li key={i} className="flex gap-2">
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      factor.impact > 0
                        ? "text-emerald-500"
                        : factor.impact < 0
                          ? "text-rose-500"
                          : "text-faint",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-body">{factor.label}</span>
                    <span className="block text-[11.5px] leading-snug text-muted">{factor.detail}</span>
                  </span>
                  {factor.impact !== 0 ? (
                    <span
                      className={cn(
                        "shrink-0 text-[11px] font-medium tabular",
                        factor.impact > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {factor.impact > 0 ? "+" : ""}
                      {factor.impact}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
