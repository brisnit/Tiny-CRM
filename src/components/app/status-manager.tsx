"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/controls";
import { createProjectStatus, deleteProjectStatus } from "@/lib/actions/settings";

const COLORS = ["#94a3b8", "#38bdf8", "#818cf8", "#068C28", "#f59e0b", "#f43f5e", "#0f766e", "#a8a29e"];

export function StatusManager({
  workspaceId,
  statuses,
}: {
  workspaceId: string;
  statuses: {
    id: string;
    name: string;
    color: string;
    isTerminal: boolean;
    isDefault: boolean;
    projectCount: number;
  }[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState(COLORS[0]!);
  const [isTerminal, setIsTerminal] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <div className="border-t border-hairline">
      <ul className="divide-y divide-hairline">
        {statuses.map((status) => (
          <li key={status.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: status.color }} />
            <span className="min-w-0 flex-1 text-[13px] text-body">{status.name}</span>
            {status.isDefault ? <Badge>Default</Badge> : null}
            {status.isTerminal ? <Badge>Terminal</Badge> : null}
            <span className="shrink-0 text-[11.5px] text-faint tabular">
              {status.projectCount} project{status.projectCount === 1 ? "" : "s"}
            </span>
            <button
              disabled={pending || status.projectCount > 0}
              title={
                status.projectCount > 0
                  ? "Move the projects in this status somewhere else first"
                  : "Delete status"
              }
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteProjectStatus(status.id);
                  if (result.ok) router.refresh();
                  else toast.error(result.error);
                })
              }
              className="shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-sunken hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="space-y-3 border-t border-hairline p-4">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Status name"
          />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1.5">
              {COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setColor(option)}
                  className="size-6 rounded-md transition-transform hover:scale-110"
                  style={{
                    background: option,
                    boxShadow: color === option ? `0 0 0 2px var(--surface-panel), 0 0 0 4px ${option}` : undefined,
                  }}
                  aria-label={`Colour ${option}`}
                />
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted">
              <Checkbox checked={isTerminal} onCheckedChange={(v) => setIsTerminal(Boolean(v))} />
              Counts as finished
            </label>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="brand"
                loading={pending}
                disabled={!name.trim()}
                onClick={() =>
                  startTransition(async () => {
                    const result = await createProjectStatus(workspaceId, { name, color, isTerminal });
                    if (result.ok) {
                      setName("");
                      setAdding(false);
                      router.refresh();
                    } else toast.error(result.error);
                  })
                }
              >
                Add status
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2.5 text-[12.5px] text-muted transition-colors hover:bg-sunken/60 hover:text-body"
        >
          <Plus className="size-3.5" />
          Add a status
        </button>
      )}
    </div>
  );
}
