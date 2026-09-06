"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/controls";
import { Badge } from "@/components/ui/badge";
import { toggleTask } from "@/lib/actions/tasks";
import { describeDeadline } from "@/lib/dates";
import { TASK_PRIORITY } from "@/lib/enums";
import { useSyncedState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export type TaskRowData = {
  id: string;
  title: string;
  dueAt: Date | string | null;
  priority: string;
  status: string;
  project?: { id: string; name: string } | null;
  deal?: { id: string; name: string } | null;
  contact?: { id: string; fullName: string } | null;
  company?: { id: string; name: string } | null;
};

/**
 * One task, completable in a single click. Uses an optimistic local state so the
 * checkbox responds instantly and reconciles when the server action returns —
 * this is the most-repeated interaction in the product.
 */
export function TaskRow({
  task,
  showLinks = true,
  className,
}: {
  task: TaskRowData;
  showLinks?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [done, setDone] = useSyncedState(task.status === "done");
  const [pending, startTransition] = React.useTransition();

  const deadline = describeDeadline(task.dueAt);

  const links = showLinks
    ? [
        task.project && { href: `/projects/${task.project.id}`, label: task.project.name },
        task.deal && { href: `/deals/${task.deal.id}`, label: task.deal.name },
        task.contact && { href: `/contacts/${task.contact.id}`, label: task.contact.fullName },
        task.company && { href: `/companies/${task.company.id}`, label: task.company.name },
      ].filter(Boolean as unknown as (v: unknown) => v is { href: string; label: string })
    : [];

  function toggle() {
    const next = !done;
    setDone(next);
    startTransition(async () => {
      const result = await toggleTask(task.id);
      if (!result.ok) {
        setDone(!next);
        toast.error(result.error);
      } else {
        if (next) toast.success("Task completed");
        router.refresh();
      }
    });
  }

  return (
    <li className={cn("group flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-sunken/50", className)}>
      <Checkbox
        checked={done}
        onCheckedChange={toggle}
        disabled={pending}
        className="mt-0.5"
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[13px] leading-snug text-body transition-colors",
            done && "text-faint line-through",
          )}
        >
          {task.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {task.dueAt ? (
            <span
              className={cn(
                "text-[11px]",
                deadline.overdue
                  ? "font-medium text-rose-600 dark:text-rose-400"
                  : deadline.urgent
                    ? "font-medium text-amber-600 dark:text-amber-400"
                    : "text-faint",
              )}
            >
              {deadline.label}
            </span>
          ) : (
            <span className="text-[11px] text-faint">No date</span>
          )}
          {task.priority === "urgent" || task.priority === "high" ? (
            <Badge tone={TASK_PRIORITY.tone(task.priority)}>{TASK_PRIORITY.label(task.priority)}</Badge>
          ) : null}
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href as never}
              className="max-w-[14rem] truncate rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hairline hover:text-body"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </li>
  );
}
