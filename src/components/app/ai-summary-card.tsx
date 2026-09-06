"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Sparkles } from "lucide-react";

import { Markdown } from "@/components/app/markdown";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/dates";
import { refreshRecordSummary } from "@/lib/actions/ai";
import { useSyncedState } from "@/lib/hooks";

/**
 * The AI summary that sits at the top of every record. Rendered from cache on
 * load; regenerating is explicit, so browsing records costs nothing.
 */
export function AiSummaryCard({
  entityType,
  entityId,
  body,
  generatedAt,
  providerLabel,
}: {
  entityType: "contact" | "company" | "deal" | "project" | "opportunity";
  entityId: string;
  body: string;
  generatedAt: string;
  providerLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [content, setContent] = useSyncedState(body);
  const [stamp, setStamp] = useSyncedState(generatedAt);

  function refresh() {
    startTransition(async () => {
      const result = await refreshRecordSummary(entityType, entityId);
      if (result.ok && result.data) {
        setContent(result.data.body);
        setStamp(new Date().toISOString());
        router.refresh();
      } else if (!result.ok) {
        toast.error(result.error, {
          action:
            result.category === "plan_limit"
              ? { label: "Upgrade", onClick: () => router.push("/settings/billing") }
              : undefined,
        });
      }
    });
  }

  return (
    <section className="rounded-xl border border-hairline bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-brand-500" />
          <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-body">Tiny AI summary</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-faint sm:inline">Updated {timeAgo(stamp)}</span>
          <Button size="icon-xs" variant="ghost" onClick={refresh} loading={pending} title="Regenerate">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="p-4">
        <Markdown content={content} />
        <p className="mt-3 border-t border-hairline pt-2.5 text-[11px] text-faint">{providerLabel}</p>
      </div>
    </section>
  );
}
