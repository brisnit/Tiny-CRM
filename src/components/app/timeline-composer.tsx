"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarDays, CheckSquare, FileText, Mail, Phone, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/select";
import { logTimelineEntry } from "@/lib/actions/activities";
import { createTask } from "@/lib/actions/tasks";
import { cn } from "@/lib/utils";

type Kind = "note" | "call" | "meeting" | "email" | "task";

const KINDS: { kind: Kind; label: string; icon: React.ElementType }[] = [
  { kind: "note", label: "Note", icon: FileText },
  { kind: "call", label: "Call", icon: Phone },
  { kind: "meeting", label: "Meeting", icon: CalendarDays },
  { kind: "email", label: "Email", icon: Mail },
  { kind: "task", label: "Task", icon: CheckSquare },
];

export type RecordLinks = {
  workspaceId: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  projectId?: string | null;
  opportunityId?: string | null;
};

/**
 * Logging what just happened, from wherever you are. Everything logged here
 * lands on the shared activity stream and updates the record's recency, which
 * is what keeps relationship and momentum scores honest.
 */
export function TimelineComposer({ links, className }: { links: RecordLinks; className?: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<Kind>("note");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [duration, setDuration] = React.useState("");
  const [direction, setDirection] = React.useState("outbound");
  const [dueAt, setDueAt] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  function reset() {
    setTitle("");
    setBody("");
    setDuration("");
    setDueAt("");
    setOpen(false);
  }

  function submit() {
    if (!title.trim()) {
      toast.error("Add a short summary first.");
      return;
    }
    startTransition(async () => {
      const result =
        kind === "task"
          ? await createTask({
              workspaceId: links.workspaceId,
              title: title.trim(),
              description: body || undefined,
              dueAt: dueAt || undefined,
              contactId: links.contactId ?? undefined,
              companyId: links.companyId ?? undefined,
              dealId: links.dealId ?? undefined,
              projectId: links.projectId ?? undefined,
              opportunityId: links.opportunityId ?? undefined,
            })
          : await logTimelineEntry({
              workspaceId: links.workspaceId,
              type: kind,
              title: title.trim(),
              body: body || undefined,
              direction: kind === "note" ? undefined : (direction as "inbound" | "outbound"),
              durationMin: duration || undefined,
              contactId: links.contactId ?? undefined,
              companyId: links.companyId ?? undefined,
              dealId: links.dealId ?? undefined,
              projectId: links.projectId ?? undefined,
              opportunityId: links.opportunityId ?? undefined,
            });

      if (result.ok) {
        toast.success(kind === "task" ? "Task created" : "Logged to the timeline");
        reset();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (!open) {
    return (
      <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
        {KINDS.map((k) => (
          <button
            key={k.kind}
            onClick={() => {
              setKind(k.kind);
              setOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:border-brand-300 hover:bg-brand-50/40 hover:text-body dark:hover:bg-brand-950/30"
          >
            <k.icon className="size-3.5" />
            {k.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline-strong bg-panel p-3", className)}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            onClick={() => setKind(k.kind)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
              kind === k.kind
                ? "border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300"
                : "border-hairline text-muted hover:bg-sunken",
            )}
          >
            <k.icon className="size-3.5" />
            {k.label}
          </button>
        ))}
      </div>

      <div className="space-y-2.5">
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            kind === "task"
              ? "What needs doing?"
              : kind === "note"
                ? "What happened?"
                : `Summary of the ${kind}`
          }
        />
        <Textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Details (optional)"
        />

        <div className="flex flex-wrap items-center gap-2">
          {kind === "task" ? (
            <Input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="w-auto"
              aria-label="Due date"
            />
          ) : kind !== "note" ? (
            <>
              <OptionSelect
                size="sm"
                value={direction}
                onValueChange={setDirection}
                options={[
                  { value: "outbound", label: "Outbound" },
                  { value: "inbound", label: "Inbound" },
                ]}
                className="w-32"
              />
              {kind !== "email" ? (
                <Input
                  inputMode="numeric"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="Minutes"
                  className="w-28"
                  aria-label="Duration in minutes"
                />
              ) : null}
            </>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button size="sm" variant="brand" onClick={submit} loading={pending}>
              <Plus className="size-3.5" />
              {kind === "task" ? "Add task" : "Log it"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
