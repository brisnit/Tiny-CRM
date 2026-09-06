"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Flag, Pencil, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { addMilestone, setProjectNextAction, toggleMilestone, updateProject } from "@/lib/actions/projects";
import { describeDeadline, dateInputValue, formatDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useSyncedState } from "@/lib/hooks";

type Status = { id: string; name: string; color: string; isTerminal: boolean };

/** Click a status to move the project. Same idea as the deal stage rail. */
export function ProjectStatusPicker({
  projectId,
  currentStatusId,
  statuses,
}: {
  projectId: string;
  currentStatusId: string | null;
  statuses: Status[];
}) {
  const router = useRouter();
  const [active, setActive] = useSyncedState(currentStatusId);
  const [pending, startTransition] = React.useTransition();

  function move(statusId: string) {
    if (statusId === active) return;
    const previous = active;
    setActive(statusId);
    startTransition(async () => {
      const result = await updateProject(projectId, { statusId });
      if (result.ok) {
        toast.success(`Moved to ${statuses.find((s) => s.id === statusId)?.name}`);
        router.refresh();
      } else {
        setActive(previous);
        toast.error(result.error);
      }
    });
  }

  return (
    <div className={cn("flex flex-wrap gap-1", pending && "opacity-70")}>
      {statuses.map((status) => {
        const isActive = status.id === active;
        return (
          <button
            key={status.id}
            onClick={() => move(status.id)}
            disabled={pending}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              isActive
                ? "border-transparent text-white"
                : "border-hairline text-muted hover:bg-sunken hover:text-body",
            )}
            style={isActive ? { background: status.color } : undefined}
          >
            {isActive ? null : (
              <span className="size-1.5 rounded-full" style={{ background: status.color }} aria-hidden />
            )}
            {status.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The next action. Given its own strip at the top of the project because "what
 * should I do next" is the question the whole product is organised around.
 */
export function NextActionEditor({
  projectId,
  nextAction,
  nextActionDueAt,
}: {
  projectId: string;
  nextAction: string | null;
  nextActionDueAt: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = useSyncedState(nextAction ?? "");
  const [due, setDue] = useSyncedState(dateInputValue(nextActionDueAt));
  const [pending, startTransition] = React.useTransition();

  function save() {
    startTransition(async () => {
      const result = await setProjectNextAction(projectId, value, due || null);
      if (result.ok) {
        setEditing(false);
        toast.success("Next action updated");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const deadline = describeDeadline(nextActionDueAt);

  if (editing) {
    return (
      <div className="rounded-xl border border-brand-300 bg-panel p-3 dark:border-brand-800">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Next action</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="What is the single next thing that moves this forward?"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="sm:w-44"
            aria-label="Due date"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              <X className="size-3.5" />
            </Button>
            <Button size="sm" variant="brand" onClick={save} loading={pending}>
              <Check className="size-3.5" />
              Save
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex w-full items-start gap-3 rounded-xl border border-hairline bg-panel p-4 text-left transition-colors hover:border-hairline-strong"
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
        <Flag className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wider text-faint">Next action</span>
        {nextAction ? (
          <>
            <span className="mt-0.5 block text-[13.5px] leading-relaxed text-body">{nextAction}</span>
            {nextActionDueAt ? (
              <span
                className={cn(
                  "mt-1 block text-[11.5px]",
                  deadline.overdue
                    ? "font-medium text-rose-600 dark:text-rose-400"
                    : deadline.urgent
                      ? "font-medium text-amber-600 dark:text-amber-400"
                      : "text-faint",
                )}
              >
                {deadline.label}
              </span>
            ) : null}
          </>
        ) : (
          <span className="mt-0.5 block text-[13.5px] text-faint">
            Nothing set. Projects without a next action drift — click to add one.
          </span>
        )}
      </span>
      <Pencil className="mt-0.5 size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export function MilestoneList({
  projectId,
  milestones,
}: {
  projectId: string;
  milestones: { id: string; name: string; dueDate: string | null; completedAt: string | null }[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [due, setDue] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  function add() {
    if (!name.trim()) return;
    startTransition(async () => {
      const result = await addMilestone(projectId, name, due || null);
      if (result.ok) {
        setName("");
        setDue("");
        setAdding(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div>
      {milestones.length === 0 && !adding ? (
        <EmptyState
          compact
          title="No milestones yet"
          description="Break the project into checkpoints so progress is visible."
          action={{ label: "Add a milestone", onClick: () => setAdding(true) }}
        />
      ) : (
        <ul className="divide-y divide-hairline">
          {milestones.map((milestone) => (
            <MilestoneRow key={milestone.id} milestone={milestone} />
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-2 border-t border-hairline p-3 sm:flex-row">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Milestone name"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="sm:w-44" />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="brand" onClick={add} loading={pending}>
              Add
            </Button>
          </div>
        </div>
      ) : milestones.length > 0 ? (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2.5 text-[12.5px] text-muted transition-colors hover:bg-sunken/60 hover:text-body"
        >
          <Plus className="size-3.5" />
          Add a milestone
        </button>
      ) : null}
    </div>
  );
}

function MilestoneRow({
  milestone,
}: {
  milestone: { id: string; name: string; dueDate: string | null; completedAt: string | null };
}) {
  const router = useRouter();
  const [done, setDone] = useSyncedState(Boolean(milestone.completedAt));
  const [pending, startTransition] = React.useTransition();

  const deadline = describeDeadline(milestone.dueDate);

  function toggle() {
    const next = !done;
    setDone(next);
    startTransition(async () => {
      const result = await toggleMilestone(milestone.id);
      if (!result.ok) {
        setDone(!next);
        toast.error(result.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Checkbox checked={done} onCheckedChange={toggle} disabled={pending} aria-label={milestone.name} />
      <span className={cn("min-w-0 flex-1 text-[13px] text-body", done && "text-faint line-through")}>
        {milestone.name}
      </span>
      {milestone.dueDate ? (
        <span
          className={cn(
            "shrink-0 text-[11.5px] tabular",
            done
              ? "text-faint"
              : deadline.overdue
                ? "font-medium text-rose-600 dark:text-rose-400"
                : deadline.urgent
                  ? "font-medium text-amber-600 dark:text-amber-400"
                  : "text-faint",
          )}
        >
          {done ? formatDay(milestone.completedAt) : deadline.label}
        </span>
      ) : null}
    </li>
  );
}
