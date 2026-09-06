"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Check, Copy, Link2, TrendingDown, UserRound, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { applyRecommendation } from "@/lib/actions/ai";
import { cn } from "@/lib/utils";

export type CleanupItem = {
  id: string;
  kind: string;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  entityType: string;
  entityIds: string[];
  action?: { label: string; type: string; payload: Record<string, unknown> };
};

const ICONS: Record<string, React.ElementType> = {
  duplicate_contact: Copy,
  duplicate_company: Copy,
  missing_company: Link2,
  stale_deal: TrendingDown,
  overdue_followup: UserRound,
  orphan_contact: UserRound,
  unanswered_email: UserRound,
};

const HREF: Record<string, string> = {
  contact: "/contacts",
  company: "/companies",
  deal: "/deals",
  project: "/projects",
  opportunity: "/opportunities",
  task: "/tasks",
};

export function CleanupList({
  recommendations,
  workspaceId,
}: {
  recommendations: CleanupItem[];
  workspaceId: string;
}) {
  const router = useRouter();
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const [applied, setApplied] = React.useState<Set<string>>(new Set());
  const [pending, startTransition] = React.useTransition();

  const visible = recommendations.filter((r) => !dismissed.has(r.id));

  if (visible.length === 0) {
    return (
      <p className="border-t border-hairline px-4 py-8 text-center text-[13px] text-faint">
        Everything on this list has been handled.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-hairline border-t border-hairline">
      {visible.map((item) => {
        const Icon = ICONS[item.kind] ?? AlertTriangle;
        const isApplied = applied.has(item.id);
        const href = item.entityIds[0] ? `${HREF[item.entityType]}/${item.entityIds[0]}` : null;

        return (
          <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                item.severity === "high"
                  ? "text-rose-500"
                  : item.severity === "medium"
                    ? "text-amber-500"
                    : "text-faint",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug text-body">{item.title}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{item.detail}</p>
              {item.entityIds.length > 1 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {item.entityIds.slice(0, 4).map((id) => (
                    <Link
                      key={id}
                      href={`${HREF[item.entityType]}/${id}` as never}
                      className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hairline hover:text-body"
                    >
                      Open record
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {isApplied ? (
                <Badge tone="bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900">
                  <Check className="size-2.5" />
                  Done
                </Badge>
              ) : item.action ? (
                <Button
                  size="xs"
                  variant="outline"
                  loading={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await applyRecommendation(
                        item.action!.type,
                        item.action!.payload,
                        workspaceId,
                      );
                      if (result.ok) {
                        setApplied((s) => new Set(s).add(item.id));
                        toast.success(item.action!.label);
                        router.refresh();
                      } else toast.error(result.error);
                    })
                  }
                >
                  {item.action.label}
                </Button>
              ) : href ? (
                <Button asChild size="xs" variant="ghost">
                  <Link href={href as never}>
                    Review
                    <ArrowRight className="size-3" />
                  </Link>
                </Button>
              ) : null}
              <button
                onClick={() => setDismissed((s) => new Set(s).add(item.id))}
                className="rounded-md p-1 text-faint transition-colors hover:bg-sunken hover:text-body"
                aria-label="Dismiss"
                title="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
