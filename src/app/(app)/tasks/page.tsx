import { Suspense } from "react";
import { CheckSquare } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { FilterBar } from "@/components/app/filter-bar";
import { Panel, PanelHeader, Skeleton } from "@/components/ui/surface";
import { StatRow, StatTile } from "@/components/app/stat-tile";
import { EmptyState } from "@/components/ui/empty-state";
import { TaskRow } from "@/components/app/task-row";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readProjectFocus, readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { TASK_PRIORITY } from "@/lib/enums";
import { formatDay } from "@/lib/dates";

export const metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  return (
    <PageShell>
      <PageHeader
        title="Tasks"
        description="The next action on everything, in one list you can finish."
        actions={<NewRecordButton kind="task" label="New task" />}
      />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <TaskList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function TaskList({ searchParams }: { searchParams: PageProps<"/tasks">["searchParams"] }) {
  const params = await searchParams;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const projectFocus = await readProjectFocus();
  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);

  const view = str("view") ?? "upcoming";
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const base: Record<string, unknown> = {
    workspaceId: { in: workspaceIds },
    ...(projectFocus ? { projectId: projectFocus } : {}),
  };
  if (str("q")) base.OR = [{ title: { contains: str("q") } }, { description: { contains: str("q") } }];
  if (str("priority")) base.priority = str("priority");

  const where: Record<string, unknown> = { ...base };
  switch (view) {
    case "today":
      where.status = { in: ["open", "in_progress"] };
      where.dueAt = { lte: endOfToday };
      break;
    case "overdue":
      where.status = { in: ["open", "in_progress"] };
      where.dueAt = { lt: now };
      break;
    case "completed":
      where.status = "done";
      break;
    case "no_date":
      where.status = { in: ["open", "in_progress"] };
      where.dueAt = null;
      break;
    default:
      where.status = { in: ["open", "in_progress"] };
  }

  const select = {
    id: true, title: true, dueAt: true, priority: true, status: true, description: true,
    project: { select: { id: true, name: true } },
    deal: { select: { id: true, name: true } },
    contact: { select: { id: true, fullName: true } },
    company: { select: { id: true, name: true } },
  };

  const [tasks, counts] = await Promise.all([
    db.task.findMany({
      where,
      select,
      orderBy:
        view === "completed"
          ? [{ completedAt: "desc" as const }]
          : [{ dueAt: "asc" as const }, { priority: "desc" as const }],
      take: 200,
    }),
    Promise.all([
      db.task.count({ where: { ...base, status: { in: ["open", "in_progress"] }, dueAt: { lt: now } } }),
      db.task.count({
        where: { ...base, status: { in: ["open", "in_progress"] }, dueAt: { gte: now, lte: endOfToday } },
      }),
      db.task.count({ where: { ...base, status: { in: ["open", "in_progress"] } } }),
      db.task.count({
        where: { ...base, status: "done", completedAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
      }),
    ]),
  ]);

  const [overdue, today, open, completedThisMonth] = counts;

  // Group by day so a long list reads as a schedule rather than a wall.
  const groups = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const key = task.dueAt
      ? task.dueAt < now && view !== "completed"
        ? "Overdue"
        : formatDay(task.dueAt)
      : "No date";
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  return (
    <div className="space-y-4">
      <StatRow className="lg:grid-cols-4">
        <StatTile
          label="Overdue"
          value={overdue}
          hint={overdue > 0 ? "Deal with these first" : "Nothing overdue"}
          tone={overdue > 0 ? "danger" : "default"}
        />
        <StatTile label="Due today" value={today} hint="Including overdue" />
        <StatTile label="Open" value={open} hint="Across everything in scope" />
        <StatTile label="Done this month" value={completedThisMonth} tone="brand" hint="Nice work" />
      </StatRow>

      <FilterBar
        searchPlaceholder="Search tasks…"
        views={[
          { value: "upcoming", label: "Upcoming", count: open },
          { value: "today", label: "Today", count: today },
          { value: "overdue", label: "Overdue", count: overdue },
          { value: "no_date", label: "No date" },
          { value: "completed", label: "Completed" },
        ]}
        filters={[{ key: "priority", label: "Priority", options: TASK_PRIORITY.options }]}
      />

      {tasks.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<CheckSquare />}
            title={view === "completed" ? "Nothing completed yet" : "Nothing here"}
            description={
              view === "overdue"
                ? "Nothing is overdue. That is worth a moment."
                : "Add a task, or clear the filters to see everything."
            }
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {Array.from(groups.entries()).map(([label, group]) => (
            <Panel key={label}>
              <PanelHeader
                title={label}
                description={`${group.length} task${group.length === 1 ? "" : "s"}`}
                className={label === "Overdue" ? "text-rose-600 dark:text-rose-400" : undefined}
              />
              <ul className="divide-y divide-hairline border-t border-hairline">
                {group.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
