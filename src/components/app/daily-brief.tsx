"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Sparkles } from "lucide-react";

import { Markdown } from "@/components/app/markdown";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/dates";
import { refreshDailyBrief } from "@/lib/actions/ai";
import { useSyncedState } from "@/lib/hooks";

/**
 * The morning brief. Server-rendered from cache on load; the refresh button is
 * the only thing that spends a model call, so opening the dashboard repeatedly
 * costs nothing.
 */
export function DailyBrief({
  greeting,
  body,
  generatedAt,
  providerLabel,
  scope,
}: {
  greeting: string;
  body: string;
  generatedAt: string;
  providerLabel: string;
  scope: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [content, setContent] = useSyncedState(body);
  const [stamp, setStamp] = useSyncedState(generatedAt);

  function refresh() {
    startTransition(async () => {
      const result = await refreshDailyBrief(scope);
      if (result.ok) {
        setContent(result.data.body);
        setStamp(new Date().toISOString());
        router.refresh();
      } else {
        toast.error(result.error, {
          action:
            result.code === "limit"
              ? { label: "Upgrade", onClick: () => router.push("/settings/billing") }
              : undefined,
        });
      }
    });
  }

  return (
    <section className="relative overflow-hidden rounded-xl border border-hairline bg-panel">
      {/* A soft brand wash so the brief reads as the page's centre of gravity. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-brand-50/70 to-transparent dark:from-brand-950/40"
      />
      <div className="relative p-5 sm:p-6">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-brand-500 text-white">
              <Sparkles className="size-4" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-body">{greeting}</h2>
              <p className="text-[11px] text-faint">
                Your daily brief · updated {timeAgo(stamp)} · {providerLabel}
              </p>
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={refresh}
            loading={pending}
            title="Regenerate the brief"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>

        <Markdown content={content} className="max-w-3xl text-[13.5px]" />
      </div>
    </section>
  );
}
