"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Download, FileUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { exportCsv, previewImport, runImport, type ExportEntity, type ImportPreview } from "@/lib/actions/import-export";

const ENTITIES: { value: ExportEntity; label: string }[] = [
  { value: "contacts", label: "Contacts" },
  { value: "companies", label: "Companies" },
  { value: "deals", label: "Deals" },
  { value: "projects", label: "Projects" },
  { value: "opportunities", label: "Opportunities" },
  { value: "tasks", label: "Tasks" },
];

export function ImportExport({
  mode,
  counts,
  workspaces,
  defaultWorkspaceId,
}: {
  mode: "import" | "export";
  counts: Record<string, number>;
  workspaces: { id: string; name: string }[];
  defaultWorkspaceId: string | null;
}) {
  if (mode === "export") return <ExportPanel counts={counts} />;
  return <ImportPanel workspaces={workspaces} defaultWorkspaceId={defaultWorkspaceId} />;
}

function ExportPanel({ counts }: { counts: Record<string, number> }) {
  const [pending, setPending] = React.useState<string | null>(null);

  async function download(entity: ExportEntity) {
    setPending(entity);
    try {
      const result = await exportCsv(entity);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? "Nothing to export." : result.error);
        return;
      }
      const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${result.data.filename}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {ENTITIES.map((entity) => (
        <button
          key={entity.value}
          onClick={() => download(entity.value)}
          disabled={pending !== null || counts[entity.value] === 0}
          className="flex items-center gap-2.5 rounded-lg border border-hairline px-3 py-2.5 text-left transition-colors hover:border-hairline-strong hover:bg-sunken/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === entity.value ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" />
          ) : (
            <Download className="size-3.5 shrink-0 text-faint" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-body">{entity.label}</span>
            <span className="block text-[11.5px] text-faint tabular">
              {(counts[entity.value] ?? 0).toLocaleString()} records
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ImportPanel({
  workspaces,
  defaultWorkspaceId,
}: {
  workspaces: { id: string; name: string }[];
  defaultWorkspaceId: string | null;
}) {
  const router = useRouter();
  const [entity, setEntity] = React.useState<"contacts" | "companies">("contacts");
  const [workspaceId, setWorkspaceId] = React.useState(defaultWorkspaceId ?? workspaces[0]?.id ?? "");
  const [csv, setCsv] = React.useState<string | null>(null);
  const [filename, setFilename] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [pending, startTransition] = React.useTransition();

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);

    const result = await previewImport(entity, text);
    if (result.ok) setPreview(result.data);
    else {
      toast.error(result.error);
      setPreview(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Import into">
          <OptionSelect
            value={entity}
            onValueChange={(v) => {
              setEntity(v as "contacts" | "companies");
              setPreview(null);
              setCsv(null);
            }}
            options={[
              { value: "contacts", label: "Contacts" },
              { value: "companies", label: "Companies" },
            ]}
          />
        </Field>
        {workspaces.length > 1 ? (
          <Field label="Workspace">
            <OptionSelect
              value={workspaceId}
              onValueChange={setWorkspaceId}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </Field>
        ) : null}
      </div>

      <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-hairline-strong px-4 py-4 transition-colors hover:border-brand-400 hover:bg-brand-50/30 dark:hover:bg-brand-950/20">
        <FileUp className="size-4 shrink-0 text-faint" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-body">
            {filename ?? "Choose a CSV file"}
          </span>
          <span className="block text-[12px] text-muted">
            Exports from HubSpot, Salesforce or Google Contacts work as-is.
          </span>
        </span>
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
      </label>

      {preview ? (
        <div className="rounded-lg border border-hairline bg-sunken/40 p-3">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">
            {preview.total.toLocaleString()} rows found
          </p>

          <div className="mt-2.5">
            <p className="mb-1.5 text-[12px] text-muted">Matched columns</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(preview.mapped).map(([field, header]) => (
                <Badge
                  key={field}
                  tone={
                    header
                      ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900"
                      : undefined
                  }
                >
                  {header ? <Check className="size-2.5" /> : null}
                  {field} {header ? `← ${header}` : "· not found"}
                </Badge>
              ))}
            </div>
          </div>

          <div className="mt-3 overflow-x-auto rounded border border-hairline bg-panel">
            <table className="w-full text-[11.5px]">
              <thead className="border-b border-hairline">
                <tr>
                  {preview.headers.slice(0, 6).map((header) => (
                    <th key={header} className="px-2 py-1.5 text-left font-semibold text-faint">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {preview.rows.map((row, i) => (
                  <tr key={i}>
                    {preview.headers.slice(0, 6).map((header) => (
                      <td key={header} className="max-w-40 truncate px-2 py-1.5 text-muted">
                        {row[header]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-[11.5px] text-faint">
              Existing records are skipped, not duplicated.
            </p>
            <Button
              size="sm"
              variant="brand"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await runImport(entity, workspaceId, csv!);
                  if (result.ok) {
                    toast.success(
                      `Imported ${result.data.created} record${result.data.created === 1 ? "" : "s"}`,
                      {
                        description:
                          result.data.skipped > 0
                            ? `${result.data.skipped} skipped as duplicates or incomplete`
                            : undefined,
                      },
                    );
                    setPreview(null);
                    setCsv(null);
                    setFilename(null);
                    router.refresh();
                  } else {
                    toast.error(result.error, {
                      action:
                        result.category === "plan_limit"
                          ? { label: "Upgrade", onClick: () => router.push("/settings/billing") }
                          : undefined,
                    });
                  }
                })
              }
            >
              Import {preview.total.toLocaleString()} rows
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
