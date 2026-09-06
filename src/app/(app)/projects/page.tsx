import Link from "next/link";
import { Suspense } from "react";
import { AlertTriangle, FolderKanban } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { FilterBar, Pagination } from "@/components/app/filter-bar";
import { Panel, Skeleton } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireUser, resolveScope } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { listProjects } from "@/lib/data/projects";
import { formatCompact } from "@/lib/money";
import { describeDeadline, timeAgo } from "@/lib/dates";
import { PROJECT_HEALTH, PROJECT_PRIORITY, PROJECT_TYPE } from "@/lib/enums";

export const metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  return (
    <PageShell wide>
      <PageHeader
        title="Projects"
        description="Every initiative with a home, a deadline and a next action."
        actions={<NewRecordButton kind="project" label="New project" />}
      />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <ProjectList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function ProjectList({
  searchParams,
}: {
  searchParams: PageProps<"/projects">["searchParams"];
}) {
  const params = await searchParams;
  const user = await requireUser();
  const { workspaceIds } = await resolveScope(user.id, await readScope());
  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);

  const { projects, statuses, total, page, pageCount } = await listProjects(workspaceIds, {
    q: str("q"),
    statusId: str("statusId"),
    type: str("type"),
    priority: str("priority"),
    view: str("view"),
    page: Number(str("page") ?? 1),
  });

  return (
    <div className="space-y-4">
      <FilterBar
        searchPlaceholder="Search projects…"
        views={[
          { value: "active", label: "Active" },
          { value: "at_risk", label: "Needs attention" },
          { value: "due_soon", label: "Due in 30 days" },
          { value: "completed", label: "Completed" },
          { value: "all", label: "All" },
        ]}
        filters={[
          { key: "statusId", label: "Status", options: statuses.map((s) => ({ value: s.id, label: s.name })) },
          { key: "type", label: "Type", options: PROJECT_TYPE.options },
          { key: "priority", label: "Priority", options: PROJECT_PRIORITY.options },
        ]}
      />

      {projects.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<FolderKanban />}
            title="Everything gets easier when work has a home"
            description="Create your first project. It becomes the command centre for the contacts, deals, tasks and files that belong to it."
          />
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => {
              const deadline = describeDeadline(project.targetDate);
              const progress =
                project.milestones.length > 0
                  ? Math.round((project.completedMilestones / project.milestones.length) * 100)
                  : null;

              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="group flex flex-col rounded-xl border border-hairline bg-panel p-4 transition-colors hover:border-hairline-strong"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-body">
                        {project.name}
                      </h3>
                      <p className="mt-0.5 truncate text-[12px] text-muted">
                        {project.company?.name ?? "Internal"}
                      </p>
                    </div>
                    <Badge tone={PROJECT_HEALTH.tone(project.health.value)}>
                      {project.health.value === "on_track" ? (
                        PROJECT_HEALTH.label(project.health.value)
                      ) : (
                        <>
                          <AlertTriangle className="size-2.5" />
                          {PROJECT_HEALTH.label(project.health.value)}
                        </>
                      )}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {project.status ? (
                      <Badge dot={project.status.color}>{project.status.name}</Badge>
                    ) : null}
                    {project.priority === "urgent" || project.priority === "high" ? (
                      <Badge tone={PROJECT_PRIORITY.tone(project.priority)}>
                        {PROJECT_PRIORITY.label(project.priority)}
                      </Badge>
                    ) : null}
                  </div>

                  {progress !== null ? (
                    <div className="mt-3.5">
                      <div className="mb-1 flex items-baseline justify-between text-[11px]">
                        <span className="text-faint">
                          {project.completedMilestones} of {project.milestones.length} milestones
                        </span>
                        <span className="text-muted tabular">{progress}%</span>
                      </div>
                      <Progress value={progress} />
                    </div>
                  ) : null}

                  {project.nextAction ? (
                    <p className="mt-3.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
                      <span className="font-medium text-body">Next: </span>
                      {project.nextAction}
                    </p>
                  ) : (
                    <p className="mt-3.5 text-[12.5px] text-faint">No next action set.</p>
                  )}

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-hairline pt-3 text-[11.5px]">
                    <span
                      className={
                        deadline.overdue
                          ? "font-medium text-rose-600 dark:text-rose-400"
                          : deadline.urgent
                            ? "font-medium text-amber-600 dark:text-amber-400"
                            : "text-faint"
                      }
                    >
                      {deadline.label}
                    </span>
                    <span className="flex items-center gap-2 text-faint">
                      {project.tasks.length > 0 ? <span>{project.tasks.length} open</span> : null}
                      {project.revenueCents ? (
                        <span className="font-medium tabular text-body">
                          {formatCompact(project.revenueCents)}
                        </span>
                      ) : null}
                    </span>
                  </div>

                  <p className="mt-1.5 text-[11px] text-faint">Updated {timeAgo(project.lastActivityAt)}</p>
                </Link>
              );
            })}
          </div>

          <Panel>
            <Pagination page={page} pageCount={pageCount} total={total} noun="project" />
          </Panel>
        </>
      )}
    </div>
  );
}
