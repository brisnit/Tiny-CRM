"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CheckCircle2, FileSpreadsheet, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { OptionSelect } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  analyzeSpreadsheet, commitImport, rollbackImport, updateImportMapping,
  type ImportPreview,
} from "@/lib/actions/import-batches";
import { FIELD_TARGETS } from "@/lib/import/targets";

/**
 * Bringing a spreadsheet in.
 *
 * The shape of the screen follows the shape of the decision: what did Tiny
 * find, what does it think each column is, what will happen if you agree, and
 * only then a button that writes anything. Every step is reversible up to the
 * last one, and the last one is reversible too.
 *
 * The mapping the person edits is sent back to the server and re-previewed
 * from the stored rows rather than recomputed in the browser, so what is on
 * screen is what will be written.
 */

type Step = "choose" | "review" | "done";

const TARGET_OPTIONS = [
  { value: "", label: "Do not import" },
  ...FIELD_TARGETS.map((t) => ({
    value: t.key,
    label: `${t.entity} · ${t.label}${t.derived ? " (recalculated)" : ""}`,
  })),
];

export function SpreadsheetImport({
  workspaces,
  defaultWorkspaceId,
}: {
  workspaces: { id: string; name: string }[];
  defaultWorkspaceId: string | null;
}) {
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = React.useState(defaultWorkspaceId ?? workspaces[0]?.id ?? "");
  const [step, setStep] = React.useState<Step>("choose");
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [result, setResult] = React.useState<{ created: Record<string, number>; batchId: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setBusy(true);
    try {
      const content = await file.text();
      const response = await analyzeSpreadsheet({ workspaceId, fileName: file.name, content });
      if (!response.ok) {
        toast.error(response.error);
        return;
      }
      setPreview(response.data);
      setStep("review");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function changeMapping(index: number, targetKey: string) {
    if (!preview) return;
    const mapping = preview.proposals.map((p) => ({
      index: p.index,
      targetKey: p.index === index ? (targetKey || null) : p.targetKey,
    }));
    setBusy(true);
    try {
      const response = await updateImportMapping({ workspaceId, batchId: preview.batchId, mapping });
      if (!response.ok) {
        toast.error(response.error);
        return;
      }
      setPreview(response.data);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const response = await commitImport({ workspaceId, batchId: preview.batchId });
      if (!response.ok) {
        toast.error(response.error);
        return;
      }
      setResult({ created: response.data.created, batchId: preview.batchId });
      setStep("done");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!result) return;
    setBusy(true);
    try {
      const response = await rollbackImport({ workspaceId, batchId: result.batchId });
      if (!response.ok) {
        toast.error(response.error);
        return;
      }
      toast.success("Import rolled back");
      setResult(null);
      setPreview(null);
      setStep("choose");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (step === "done" && result) {
    const total = Object.values(result.created).reduce((a, b) => a + b, 0);
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-body">{total} records imported</p>
            <p className="mt-0.5 text-[12px] text-muted">
              {Object.entries(result.created)
                .filter(([, n]) => n > 0)
                .map(([entity, n]) => `${n} ${entity}${n === 1 ? "" : "s"}`)
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="brand" onClick={() => router.push("/opportunities")}>
            View my data
            <ArrowRight className="size-3.5" />
          </Button>
          <Button variant="ghost" onClick={undo} disabled={busy}>
            <Undo2 className="size-3.5" />
            Undo this import
          </Button>
        </div>
      </div>
    );
  }

  if (step === "review" && preview) {
    return (
      <ReviewStep
        preview={preview}
        busy={busy}
        onChangeMapping={changeMapping}
        onCommit={commit}
        onCancel={() => { setPreview(null); setStep("choose"); }}
      />
    );
  }

  return (
    <div className="space-y-3.5">
      {workspaces.length > 1 ? (
        <Field label="Workspace">
          <OptionSelect
            value={workspaceId}
            onValueChange={(v) => setWorkspaceId(v ?? "")}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        </Field>
      ) : null}

      <label
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-hairline-strong",
          "bg-sunken/40 px-6 py-10 text-center transition-colors hover:border-brand-400 hover:bg-sunken",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <FileSpreadsheet className="size-6 text-faint" />
        <span className="text-[13px] font-medium text-body">
          {busy ? "Reading…" : "Drop your spreadsheet, or choose a file"}
        </span>
        <span className="text-[12px] text-muted">
          CSV. Nothing is written until you have seen what it will do.
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
      </label>
    </div>
  );
}

function ReviewStep({
  preview, busy, onChangeMapping, onCommit, onCancel,
}: {
  preview: ImportPreview;
  busy: boolean;
  onChangeMapping: (index: number, targetKey: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const counts = Object.entries(preview.summary.byEntity).filter(([, n]) => n > 0);

  return (
    <div className="space-y-5">
      {/* What Tiny found */}
      <section className="space-y-2">
        <h3 className="text-[13px] font-medium text-body">Here&rsquo;s what I found</h3>
        <div className="flex flex-wrap gap-1.5">
          {preview.sheets.map((sheet) => (
            <Badge key={sheet.name} tone={sheet.name === preview.sheetName ? "green" : "stone"}>
              {sheet.name} — {sheet.shape === "records" ? `${sheet.rowCount} records` : sheet.shape}
            </Badge>
          ))}
        </div>
        {preview.preamble.length > 0 ? (
          <p className="text-[12px] text-muted">
            Skipped {preview.preamble.length} row{preview.preamble.length === 1 ? "" : "s"} above the header,
            and {preview.trailing.length} note row{preview.trailing.length === 1 ? "" : "s"} below the data.
          </p>
        ) : null}
      </section>

      {/* What will be created */}
      <section className="rounded-lg border border-hairline bg-panel p-4">
        <p className="text-[13px] font-medium text-body">
          {counts.map(([entity, n]) => `${n} ${entity}${n === 1 ? "" : "s"}`).join(" · ") || "Nothing"}
        </p>
        <p className="mt-1 text-[12px] text-muted">
          from {preview.summary.rows} row{preview.summary.rows === 1 ? "" : "s"}
          {preview.summary.skipped > 0 ? `, ${preview.summary.skipped} skipped` : ""}
          {preview.duplicates.length > 0
            ? ` · ${preview.duplicates[0]!.count} existing companies will be reused rather than duplicated`
            : ""}
        </p>
      </section>

      {preview.planProblem ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            This import needs {preview.planProblem.needed} {preview.planProblem.limitKey}, and your plan allows{" "}
            {preview.planProblem.limit}. Nothing will be imported until there is room — Tiny will not fill up to
            the limit and stop partway.
          </span>
        </div>
      ) : null}

      {/* The mapping */}
      <section className="space-y-2">
        <h3 className="text-[13px] font-medium text-body">What each column becomes</h3>
        <div className="overflow-x-auto rounded-lg border border-hairline">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead className="bg-sunken/60 text-left text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Column</th>
                <th className="px-3 py-2 font-medium">Example</th>
                <th className="px-3 py-2 font-medium">Becomes</th>
                <th className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {preview.proposals.map((p) => (
                <tr key={p.index} className={cn(!p.targetKey && "bg-sunken/30")}>
                  <td className="px-3 py-2 font-medium text-body">{p.header || <em className="text-faint">no header</em>}</td>
                  <td className="max-w-[180px] truncate px-3 py-2 text-muted">{p.samples[0] ?? "—"}</td>
                  <td className="px-3 py-2">
                    <OptionSelect
                      value={p.targetKey ?? ""}
                      onValueChange={(v) => onChangeMapping(p.index, v ?? "")}
                      options={TARGET_OPTIONS}
                    />
                  </td>
                  <td className="px-3 py-2 text-muted">{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* What will not come across */}
      {preview.summary.unmappedColumns.length > 0 || preview.summary.derivedColumns.length > 0 ? (
        <section className="space-y-2 rounded-lg border border-hairline bg-sunken/40 p-4 text-[12px]">
          <h3 className="text-[13px] font-medium text-body">What will not be written</h3>
          {preview.summary.derivedColumns.length > 0 ? (
            <p className="text-muted">
              <span className="font-medium text-body">Recalculated by Tiny:</span>{" "}
              {preview.summary.derivedColumns.join(", ")}. The spreadsheet&rsquo;s values are kept on the import
              record so you can compare them, but the live figure is Tiny&rsquo;s.
            </p>
          ) : null}
          {preview.summary.unmappedColumns.length > 0 ? (
            <p className="text-muted">
              <span className="font-medium text-body">No field for these:</span>{" "}
              {preview.summary.unmappedColumns.join(", ")}. They stay on the import record and can be mapped
              above if one of them belongs somewhere.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Row by row */}
      <section className="space-y-2">
        <h3 className="text-[13px] font-medium text-body">First rows, as they will be written</h3>
        {preview.sample.length === 0 ? (
          <EmptyState compact title="No rows" description="Nothing in this sheet maps to a record." />
        ) : (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {preview.sample.map((row) => (
              <li key={row.rowIndex} className="px-3 py-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-faint">Row {row.rowIndex + 1}</span>
                  {row.entities.map((e, i) => (
                    <Badge key={i} tone={e.match === "existing" ? "amber" : "green"}>
                      {e.entity}: {e.label.slice(0, 40)}{e.match === "existing" ? " (existing)" : ""}
                    </Badge>
                  ))}
                  {row.decision === "skip" ? <Badge tone="stone">skipped — {row.note}</Badge> : null}
                </div>
                {row.issues.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-amber-700 dark:text-amber-400">
                    {row.issues.map((issue, i) => (
                      <li key={i}>
                        {issue.column}: &ldquo;{issue.raw.slice(0, 40)}&rdquo; — {issue.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button variant="brand" onClick={onCommit} loading={busy} disabled={busy || counts.length === 0}>
          Import {preview.summary.rows} row{preview.summary.rows === 1 ? "" : "s"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Start over
        </Button>
      </div>
    </div>
  );
}
