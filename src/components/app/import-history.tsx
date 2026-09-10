"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { rollbackImport } from "@/lib/actions/import-batches";

export type ImportHistoryRow = {
  id: string;
  sourceName: string;
  sheetName: string | null;
  status: string;
  rowCount: number;
  createdCount: number;
  matchedCount: number;
  skippedCount: number;
  errorCount: number;
  when: string;
  who: string;
  rolledBack: boolean;
  lastError: string | null;
};

const TONE: Record<string, "green" | "amber" | "stone" | "rose"> = {
  committed: "green",
  previewed: "amber",
  draft: "stone",
  rolled_back: "stone",
  failed: "rose",
};

/**
 * What was imported, by whom, and what it did.
 *
 * The counts are the four a person actually asks about after the fact —
 * created, matched, skipped, errored — and the undo is here rather than only
 * on the success screen, because the moment somebody wants it is usually a
 * day later.
 */
export function ImportHistory({
  workspaceId,
  batches,
}: {
  workspaceId: string;
  batches: ImportHistoryRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function undo(batchId: string) {
    setBusy(batchId);
    try {
      const result = await rollbackImport({ workspaceId, batchId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const removed = Object.entries(result.data.removed)
        .filter(([, n]) => n > 0)
        .map(([entity, n]) => `${n} ${entity}${n === 1 ? "" : "s"}`)
        .join(", ");
      toast.success(removed ? `Removed ${removed}` : "Import rolled back");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="divide-y divide-hairline">
      {batches.map((batch) => (
        <li key={batch.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-medium text-body">{batch.sourceName}</span>
              {batch.sheetName ? <span className="text-[12px] text-faint">· {batch.sheetName}</span> : null}
              <Badge tone={TONE[batch.status] ?? "stone"}>
                {batch.rolledBack ? "rolled back" : batch.status.replace("_", " ")}
              </Badge>
            </div>
            <p className="mt-0.5 text-[12px] text-muted">
              {batch.when} · {batch.who} · {batch.rowCount} row{batch.rowCount === 1 ? "" : "s"}
              {batch.createdCount > 0 ? ` · ${batch.createdCount} created` : ""}
              {batch.matchedCount > 0 ? ` · ${batch.matchedCount} matched` : ""}
              {batch.skippedCount > 0 ? ` · ${batch.skippedCount} skipped` : ""}
              {batch.errorCount > 0 ? ` · ${batch.errorCount} errored` : ""}
            </p>
            {batch.lastError ? (
              <p className="mt-0.5 text-[12px] text-rose-600 dark:text-rose-400">{batch.lastError}</p>
            ) : null}
          </div>
          {batch.status === "committed" && !batch.rolledBack ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => undo(batch.id)}
              loading={busy === batch.id}
              disabled={busy != null}
            >
              <Undo2 className="size-3" />
              Undo
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
