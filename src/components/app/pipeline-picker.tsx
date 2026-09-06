"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

/** Tab strip for switching between a workspace's pipelines. */
export function PipelinePicker({
  pipelines,
  activeId,
}: {
  pipelines: { id: string; name: string; workspaceName: string; isDefault: boolean }[];
  activeId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (pipelines.length <= 1) return null;

  function choose(id: string) {
    const next = new URLSearchParams(params.toString());
    next.set("pipeline", id);
    router.replace(`${pathname}?${next.toString()}` as never, { scroll: false });
  }

  // With several workspaces in scope the same pipeline name can appear twice,
  // so disambiguate by workspace only when it is actually ambiguous.
  const names = new Map<string, number>();
  for (const p of pipelines) names.set(p.name, (names.get(p.name) ?? 0) + 1);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-hairline">
      {pipelines.map((pipeline) => (
        <button
          key={pipeline.id}
          onClick={() => choose(pipeline.id)}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
            pipeline.id === activeId
              ? "border-brand-500 text-body"
              : "border-transparent text-muted hover:text-body",
          )}
        >
          {pipeline.name}
          {(names.get(pipeline.name) ?? 0) > 1 ? (
            <span className="ml-1.5 text-[11px] text-faint">{pipeline.workspaceName}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
