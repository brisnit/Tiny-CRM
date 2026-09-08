import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle, Building2, CalendarDays, CheckSquare, FileText, Flag, Landmark,
  Mail, Paperclip, Target, Users,
} from "lucide-react";

import { PageHeader, PageShell, MetaItem } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { StatRow, StatTile } from "@/components/app/stat-tile";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/controls";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { ActivityFeed } from "@/components/app/activity-feed";
import { TimelineComposer } from "@/components/app/timeline-composer";
import { AiSummaryCard } from "@/components/app/ai-summary-card";
import { ScoreExplainer } from "@/components/app/score-explainer";
import { AskAiButton } from "@/components/app/ask-ai-button";
import { RelatedList } from "@/components/app/related-list";
import { TaskRow } from "@/components/app/task-row";
import { RecordHeaderActions } from "@/components/app/record-edit";
import { AddProjectPerson, RemoveProjectPerson } from "@/components/app/project-people";
import { ProjectStatusPicker, NextActionEditor, MilestoneList } from "@/components/app/project-controls";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { getProject } from "@/lib/data/projects";
import { getEditContext } from "@/lib/data/shell";
import { getRecordSummary } from "@/lib/ai/summaries";
import { describeProvider } from "@/lib/ai/provider";
import { formatCompact, formatMoney } from "@/lib/money";
import { describeDeadline, formatDate, formatDay, timeAgo } from "@/lib/dates";
import { PROJECT_HEALTH, PROJECT_PRIORITY, PROJECT_TYPE, SUBMISSION_STATUS } from "@/lib/enums";

export async function generateMetadata({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const project = await getProject(workspaceIds, id);
  return { title: project?.name ?? "Project" };
}

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const project = await getProject(workspaceIds, id);
  if (!project) notFound();

  const workspaces = actor.memberships;
  const summary = await getRecordSummary(
    actor,
    { workspaceIds, workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])) },
    "project",
    id,
    { workspaceId: project.workspaceId },
  );

  const editContext = await getEditContext(actor, [project.workspaceId]);

  const deadline = describeDeadline(project.targetDate);
  const completedMilestones = project.milestones.filter((m) => m.completedAt).length;
  const progress =
    project.milestones.length > 0
      ? Math.round((completedMilestones / project.milestones.length) * 100)
      : null;
  const openDeals = project.deals.filter((d) => d.stage.kind === "open");
  const upcomingDeadlines = [
    ...project.milestones
      .filter((m) => !m.completedAt && m.dueDate)
      .map((m) => ({ id: m.id, label: m.name, date: m.dueDate!, kind: "Milestone" })),
    ...project.openTasks
      .filter((t) => t.dueAt)
      .map((t) => ({ id: t.id, label: t.title, date: t.dueAt!, kind: "Task" })),
    ...project.opportunities
      .filter((o) => o.deadlineAt)
      .map((o) => ({ id: o.id, label: o.name, date: o.deadlineAt!, kind: "Opportunity" })),
  ]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 6);

  return (
    <PageShell wide>
      <PageHeader
        backHref="/projects"
        backLabel="Projects"
        eyebrow={project.workspace.name}
        title={project.name}
        description={project.description ?? undefined}
        meta={
          <>
            <ScoreExplainer
              label={PROJECT_HEALTH.label(project.health.value)}
              tone={PROJECT_HEALTH.tone(project.health.value)}
              score={project.health.score}
              summary={project.health.summary}
              factors={project.health.factors}
              caption="What drives this health rating"
            />
            {project.company ? (
              <MetaItem label="Client" icon={<Building2 />}>
                <Link href={`/companies/${project.company.id}`} className="hover:underline">
                  {project.company.name}
                </Link>
              </MetaItem>
            ) : null}
            {project.owner ? <MetaItem label="Owner">{project.owner.name}</MetaItem> : null}
            <MetaItem label="Priority">{PROJECT_PRIORITY.label(project.priority)}</MetaItem>
            {project.type ? <MetaItem label="Type">{PROJECT_TYPE.label(project.type)}</MetaItem> : null}
          </>
        }
        actions={
          <>
            <AskAiButton focus={{ type: "project", id: project.id, label: project.name }} />
            <RecordHeaderActions
              kind="project"
              id={project.id}
              name={project.name}
              version={project.version}
              context={editContext}
              initial={{
                name: project.name,
                description: project.description,
                companyId: project.companyId,
                statusId: project.statusId,
                targetDate: project.targetDate ? project.targetDate.toISOString().slice(0, 10) : "",
                priority: project.priority,
              }}
            />
          </>
        }
      />

      {/* Command bar: status, deadline, money */}
      <div className="mb-5 space-y-4">
        <ProjectStatusPicker
          projectId={project.id}
          currentStatusId={project.statusId}
          statuses={project.statuses}
        />

        <StatRow>
          <StatTile
            label="Deadline"
            value={formatDay(project.targetDate, "Not set")}
            hint={deadline.label}
            tone={deadline.overdue ? "danger" : deadline.urgent ? "warn" : "default"}
            icon={<CalendarDays />}
          />
          <StatTile
            label="Progress"
            value={progress === null ? "—" : `${progress}%`}
            hint={
              project.milestones.length > 0
                ? `${completedMilestones} of ${project.milestones.length} milestones`
                : "No milestones yet"
            }
            icon={<Flag />}
          />
          <StatTile
            label="Open work"
            value={project.openTasks.length}
            hint={project.overdueTasks > 0 ? `${project.overdueTasks} overdue` : "Nothing overdue"}
            tone={project.overdueTasks > 0 ? "danger" : "default"}
            icon={<CheckSquare />}
          />
          <StatTile
            label="Value"
            value={formatCompact(project.revenueCents ?? project.budgetCents ?? 0)}
            hint={
              project.budgetCents && project.revenueCents
                ? `Budget ${formatCompact(project.budgetCents)}`
                : project.budgetCents
                  ? "Budget"
                  : "Revenue"
            }
            tone="brand"
          />
          <StatTile
            label="Pipeline"
            value={formatCompact(openDeals.reduce((sum, d) => sum + d.valueCents, 0))}
            hint={`${openDeals.length} open deal${openDeals.length === 1 ? "" : "s"}`}
            icon={<Target />}
          />
        </StatRow>

        <NextActionEditor
          projectId={project.id}
          nextAction={project.nextAction}
          nextActionDueAt={project.nextActionDueAt?.toISOString() ?? null}
        />
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {summary ? (
            <AiSummaryCard
              entityType="project"
              entityId={project.id}
              body={summary.body}
              generatedAt={summary.generatedAt.toISOString()}
              providerLabel={describeProvider().label}
            />
          ) : null}

          {project.health.value !== "on_track" ? (
            <Panel className="border-amber-200 dark:border-amber-900">
              <PanelHeader
                title="Risks"
                description={project.health.summary}
                icon={<AlertTriangle className="text-amber-500" />}
              />
              <ul className="space-y-2 border-t border-hairline p-4">
                {project.health.factors
                  .filter((f) => f.impact < 0)
                  .map((factor, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-body">{factor.label}</span>
                        <span className="block text-[12.5px] leading-relaxed text-muted">{factor.detail}</span>
                      </span>
                    </li>
                  ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader
              title="Milestones"
              icon={<Flag />}
              description={progress === null ? "Break the work into checkpoints" : `${progress}% complete`}
            />
            <div className="border-t border-hairline">
              {progress !== null ? (
                <div className="px-4 pt-4">
                  <Progress value={progress} />
                </div>
              ) : null}
              <MilestoneList
                projectId={project.id}
                milestones={project.milestones.map((m) => ({
                  id: m.id,
                  name: m.name,
                  dueDate: m.dueDate?.toISOString() ?? null,
                  completedAt: m.completedAt?.toISOString() ?? null,
                }))}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Tasks"
              icon={<CheckSquare />}
              description={`${project.openTasks.length} open · ${project.doneTasks.length} done`}
            />
            {project.openTasks.length === 0 ? (
              <div className="border-t border-hairline">
                <EmptyState
                  compact
                  title="No open tasks"
                  description="A project with no tasks has nothing pushing it forward."
                />
              </div>
            ) : (
              <ul className="divide-y divide-hairline border-t border-hairline">
                {project.openTasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="border-t border-hairline p-4">
              <TimelineComposer
                className="mb-5"
                links={{
                  workspaceId: project.workspaceId,
                  projectId: project.id,
                  companyId: project.company?.id ?? null,
                }}
              />
              {project.activities.length === 0 ? (
                <EmptyState compact title="Nothing logged yet" description="Record what has happened on this project." />
              ) : (
                <ActivityFeed items={project.activities} />
              )}
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel>
            <PanelHeader title="Overview" />
            <dl className="divide-y divide-hairline border-t border-hairline text-[13px]">
              <Row label="Status">
                {project.status ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: project.status.color }} />
                    {project.status.name}
                  </span>
                ) : null}
              </Row>
              <Row label="Start">{formatDate(project.startDate, "Not set")}</Row>
              <Row label="Target">{formatDate(project.targetDate, "Not set")}</Row>
              <Row label="Budget">{project.budgetCents ? formatMoney(project.budgetCents) : null}</Row>
              <Row label="Revenue">{project.revenueCents ? formatMoney(project.revenueCents) : null}</Row>
              <Row label="Last activity">{timeAgo(project.lastActivityAt)}</Row>
            </dl>

            {project.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline p-4">
                {project.tags.map((tag) => (
                  <Badge key={tag.name} dot={tag.color}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Panel>

          {upcomingDeadlines.length > 0 ? (
            <RelatedList
              title="Upcoming deadlines"
              icon={<CalendarDays />}
              emptyTitle="No deadlines"
              items={upcomingDeadlines.map((item) => {
                const d = describeDeadline(item.date);
                return {
                  id: item.id,
                  title: item.label,
                  subtitle: item.kind,
                  trailing: (
                    <span
                      className={`text-[11.5px] ${
                        d.overdue
                          ? "font-medium text-rose-600 dark:text-rose-400"
                          : d.urgent
                            ? "font-medium text-amber-600 dark:text-amber-400"
                            : "text-faint"
                      }`}
                    >
                      {d.label}
                    </span>
                  ),
                };
              })}
            />
          ) : null}

          <RelatedList
            title="People"
            icon={<Users />}
            emptyTitle="No contacts attached"
            emptyDescription="Add the client contacts and collaborators on this project."
            action={<AddProjectPerson projectId={project.id} workspaceId={project.workspaceId} />}
            items={project.contacts.map((link) => ({
              id: link.contact.id,
              href: `/contacts/${link.contact.id}`,
              title: link.contact.fullName,
              subtitle: link.contact.jobTitle ?? link.contact.email,
              leading: <Avatar name={link.contact.fullName} size="sm" />,
              trailing: (
                <RemoveProjectPerson
                  projectId={project.id}
                  contactId={link.contact.id}
                  name={link.contact.fullName}
                />
              ),
            }))}
          />

          <RelatedList
            title="Deals"
            icon={<Target />}
            emptyTitle="No deals"
            emptyDescription="Revenue attached to this project shows here."
            items={project.deals.map((deal) => ({
              id: deal.id,
              href: `/deals/${deal.id}`,
              title: deal.name,
              subtitle: deal.stage.name,
              leading: <span className="size-2 shrink-0 rounded-full" style={{ background: deal.stage.color }} />,
              trailing: (
                <span className="text-[12.5px] font-medium tabular text-body">
                  {formatCompact(deal.valueCents)}
                </span>
              ),
            }))}
          />

          {project.opportunities.length > 0 ? (
            <RelatedList
              title="Opportunities"
              icon={<Landmark />}
              emptyTitle="No opportunities"
              items={project.opportunities.map((opp) => ({
                id: opp.id,
                href: `/opportunities/${opp.id}`,
                title: opp.name,
                subtitle: `Due ${formatDay(opp.deadlineAt, "unset")}`,
                trailing: (
                  <Badge tone={SUBMISSION_STATUS.tone(opp.submissionStatus)}>
                    {SUBMISSION_STATUS.label(opp.submissionStatus)}
                  </Badge>
                ),
              }))}
            />
          ) : null}

          {project.notes.length > 0 ? (
            <RelatedList
              title="Notes"
              icon={<FileText />}
              emptyTitle="No notes"
              items={project.notes.map((note) => ({
                id: note.id,
                href: `/notes/${note.id}`,
                title: note.title ?? "Untitled note",
                subtitle: note.plainText.slice(0, 100),
              }))}
            />
          ) : null}

          {project.files.length > 0 ? (
            <RelatedList
              title="Files"
              icon={<Paperclip />}
              emptyTitle="No files"
              items={project.files.map((file) => ({
                id: file.id,
                title: file.name,
                subtitle: `${Math.round(file.sizeBytes / 1024)} KB · ${formatDay(file.createdAt)}`,
              }))}
            />
          ) : null}

          {project.emails.length > 0 ? (
            <RelatedList
              title="Recent email"
              icon={<Mail />}
              emptyTitle="No email"
              items={project.emails.map((email) => ({
                id: email.id,
                title: email.subject,
                subtitle: email.snippet,
                trailing: email.needsReply ? (
                  <Badge tone="bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">
                    Needs reply
                  </Badge>
                ) : null,
              }))}
            />
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}

function Row({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <dt className="w-28 shrink-0 text-[12px] text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-body">{children || <span className="text-faint">—</span>}</dd>
    </div>
  );
}
