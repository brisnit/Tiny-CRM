import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckSquare, Clock, FolderKanban,
  Landmark, Target, TrendingUp, UserRound, Video,
} from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { StatRow, StatTile } from "@/components/app/stat-tile";
import { DailyBrief } from "@/components/app/daily-brief";
import { ActivityFeed } from "@/components/app/activity-feed";
import { Panel, PanelHeader, Skeleton } from "@/components/ui/surface";
import { Badge, DotLabel } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { TaskRow } from "@/components/app/task-row";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readProjectFocus, readScope } from "@/lib/scope";
import { getDashboard } from "@/lib/data/dashboard";
import { getDailyBrief } from "@/lib/ai/summaries";
import { describeProvider } from "@/lib/ai/provider";
import { db } from "@/lib/db";
import { formatCompact, formatMoney } from "@/lib/money";
import { daysSince, describeDeadline, formatDay, formatTime, timeAgo } from "@/lib/dates";
import { PROJECT_HEALTH, SUBMISSION_STATUS, TONE } from "@/lib/enums";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Home" };

export default async function HomePage() {
  const actor = await requireActor();
  const scopeCookie = await readScope();
  const projectFocus = await readProjectFocus();
  const { workspaceIds, isAll } = await resolveReadScope(scopeCookie);
  const scope = isAll ? "all" : (workspaceIds[0] ?? "all");

  const workspaces = actor.memberships;
  const [dashboard, todayTasks] = await scopedRead(workspaceIds, async () => {
    return Promise.all([
      getDashboard(workspaceIds, projectFocus),
      db.task.findMany({
        where: {
          workspaceId: { in: workspaceIds },
          status: { in: ["open", "in_progress"] },
          ...(projectFocus ? { projectId: projectFocus } : {}),
          dueAt: { lte: endOfToday() },
        },
        select: {
          id: true, title: true, dueAt: true, priority: true, status: true, workspaceId: true,
          project: { select: { id: true, name: true } },
          deal: { select: { id: true, name: true } },
          contact: { select: { id: true, fullName: true } },
          company: { select: { id: true, name: true } },
        },
        orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
        take: 8,
      }),
    ]);
  });

  const scopeLabel = isAll
    ? "All Businesses"
    : (workspaces.find((w) => w.id === scope)?.name ?? "Workspace");

  const atRisk = dashboard.projects.list.filter((p) => p.computedHealth.value !== "on_track");

  return (
    <PageShell wide>
      <PageHeader
        eyebrow={scopeLabel}
        title={`${greeting()}, ${actor.identity.name.split(" ")[0]}`}
        description="Everything that needs you, in one place."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/tasks">
                <CheckSquare className="size-3.5" />
                Tasks
              </Link>
            </Button>
            <Button asChild variant="brand" size="sm">
              <Link href="/deals">
                <Target className="size-3.5" />
                Pipeline
              </Link>
            </Button>
          </>
        }
      />

      <div className="space-y-5">
        <Suspense fallback={<BriefSkeleton />}>
          <BriefBlock scope={scope} scopeCookie={scopeCookie} />
        </Suspense>

        <StatRow>
          <StatTile
            label="Pipeline"
            value={formatCompact(dashboard.pipeline.valueCents)}
            hint={`${dashboard.pipeline.count} open deal${dashboard.pipeline.count === 1 ? "" : "s"}`}
            href="/deals"
            icon={<Target />}
            tone="brand"
          />
          <StatTile
            label="Forecast"
            value={formatCompact(dashboard.pipeline.forecastCents)}
            hint="Weighted by win probability"
            href="/analytics"
            icon={<TrendingUp />}
          />
          <StatTile
            label="Due today"
            value={dashboard.tasks.today}
            hint={
              dashboard.tasks.overdue > 0
                ? `${dashboard.tasks.overdue} overdue`
                : "Nothing overdue"
            }
            href="/tasks?view=today"
            icon={<Clock />}
            tone={dashboard.tasks.overdue > 0 ? "danger" : "default"}
          />
          <StatTile
            label="Active projects"
            value={dashboard.projects.active}
            hint={
              dashboard.projects.atRisk > 0
                ? `${dashboard.projects.atRisk} need attention`
                : "All on track"
            }
            href="/projects"
            icon={<FolderKanban />}
            tone={dashboard.projects.atRisk > 0 ? "warn" : "default"}
          />
          <StatTile
            label="Won this month"
            value={formatCompact(dashboard.won.valueCents)}
            hint={`${dashboard.won.count} deal${dashboard.won.count === 1 ? "" : "s"} closed`}
            href="/analytics"
            icon={<TrendingUp />}
            tone="brand"
          />
        </StatRow>

        <div className="grid min-w-0 gap-5 lg:grid-cols-3">
          <div className="min-w-0 space-y-5 lg:col-span-2">
            {/* Today */}
            <Panel>
              <PanelHeader
                title="Today"
                description={
                  todayTasks.length === 0
                    ? "Nothing is due — a good day to work ahead."
                    : `${todayTasks.length} thing${todayTasks.length === 1 ? "" : "s"} due or overdue`
                }
                icon={<CheckSquare />}
                action={
                  <Button asChild size="xs" variant="ghost">
                    <Link href="/tasks">
                      All tasks
                      <ArrowRight className="size-3" />
                    </Link>
                  </Button>
                }
              />
              {todayTasks.length === 0 ? (
                <EmptyState
                  compact
                  title="Clear for today"
                  description="Nothing is due. Pick something from Upcoming, or add a task."
                />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {todayTasks.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </ul>
              )}
            </Panel>

            {/* Deals needing attention */}
            <Panel>
              <PanelHeader
                title="Deals that need a push"
                description="Ranked by how much momentum they have lost"
                icon={<Target />}
                action={
                  <Button asChild size="xs" variant="ghost">
                    <Link href="/deals">
                      Pipeline
                      <ArrowRight className="size-3" />
                    </Link>
                  </Button>
                }
              />
              {dashboard.needsAttention.length === 0 ? (
                <EmptyState
                  compact
                  title="Every deal is moving"
                  description="Nothing has stalled. Keep the cadence."
                />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {dashboard.needsAttention.map((deal) => (
                    <li key={deal.id}>
                      <Link
                        href={`/deals/${deal.id}`}
                        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-sunken/60"
                      >
                        <span
                          className="mt-1.5 size-2 shrink-0 rounded-full"
                          style={{ background: deal.stage.color }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className="truncate text-[13px] font-medium text-body">{deal.name}</span>
                            <span className="text-[12px] text-muted">{deal.company?.name}</span>
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
                            <Badge tone={momentumTone(deal.intel.momentum.value)}>
                              {deal.intel.momentum.value === "stalled" ? "Stalled" : "Slowing"}
                            </Badge>
                            <span>{deal.stage.name}</span>
                            <span>· win {deal.intel.winProbability}%</span>
                            <span>· last activity {timeAgo(deal.lastActivityAt)}</span>
                          </span>
                          {deal.intel.risks[0] ? (
                            <span className="mt-1 block text-[12px] text-muted">{deal.intel.risks[0]}</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[13px] font-medium tabular text-body">
                          {formatCompact(deal.valueCents)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/* Recent activity */}
            <Panel>
              <PanelHeader title="Recent activity" description="What has happened across the business" />
              <div className="border-t border-hairline p-4">
                {dashboard.recentActivity.length === 0 ? (
                  <EmptyState
                    compact
                    title="Nothing logged yet"
                    description="Calls, meetings, emails and notes will show up here as you record them."
                  />
                ) : (
                  <ActivityFeed items={dashboard.recentActivity} dense />
                )}
              </div>
            </Panel>
          </div>

          <div className="min-w-0 space-y-5">
            {/* Projects at risk */}
            <Panel>
              <PanelHeader
                title="Projects needing attention"
                icon={<AlertTriangle />}
                action={
                  <Button asChild size="xs" variant="ghost">
                    <Link href="/projects">All</Link>
                  </Button>
                }
              />
              {atRisk.length === 0 ? (
                <EmptyState compact title="Everything is on track" description="No project is slipping right now." />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {atRisk.slice(0, 5).map((project) => (
                    <li key={project.id}>
                      <Link
                        href={`/projects/${project.id}`}
                        className="block px-4 py-3 transition-colors hover:bg-sunken/60"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-body">{project.name}</span>
                          <Badge tone={PROJECT_HEALTH.tone(project.computedHealth.value)}>
                            {PROJECT_HEALTH.label(project.computedHealth.value)}
                          </Badge>
                        </div>
                        {project.company ? (
                          <p className="mt-0.5 truncate text-[12px] text-muted">{project.company.name}</p>
                        ) : null}
                        <p className="mt-1 text-[12px] text-muted">
                          {project.computedHealth.factors[0]?.detail ?? project.computedHealth.summary}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/* Upcoming meetings */}
            <Panel>
              <PanelHeader
                title="This week"
                icon={<CalendarDays />}
                action={
                  <Button asChild size="xs" variant="ghost">
                    <Link href="/calendar">Calendar</Link>
                  </Button>
                }
              />
              {dashboard.upcomingEvents.length === 0 ? (
                <EmptyState compact title="No meetings scheduled" description="The next seven days are clear." />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {dashboard.upcomingEvents.map((event) => (
                    <li key={event.id} className="flex items-start gap-3 px-4 py-3">
                      <div className="w-11 shrink-0 text-center">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
                          {formatDay(event.startAt)}
                        </div>
                        <div className="text-[12px] font-medium tabular text-body">{formatTime(event.startAt)}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-body">{event.title}</p>
                        <p className="truncate text-[12px] text-muted">
                          {[event.contact?.fullName, event.project?.name].filter(Boolean).join(" · ") || "No attendees"}
                        </p>
                      </div>
                      {event.meetingUrl ? (
                        <a
                          href={event.meetingUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-sunken hover:text-body"
                          title="Join"
                        >
                          <Video className="size-3.5" />
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/* Follow-ups */}
            <Panel>
              <PanelHeader
                title="People to reach"
                icon={<UserRound />}
                action={
                  <Button asChild size="xs" variant="ghost">
                    <Link href="/contacts">All</Link>
                  </Button>
                }
              />
              {dashboard.contactsToFollowUp.length === 0 ? (
                <EmptyState compact title="Everyone is up to date" description="No follow-ups are overdue." />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {dashboard.contactsToFollowUp.map((contact) => {
                    const since = daysSince(contact.lastContactedAt);
                    const overdue = contact.nextFollowUpAt && contact.nextFollowUpAt < new Date();
                    return (
                      <li key={contact.id}>
                        <Link
                          href={`/contacts/${contact.id}`}
                          className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-sunken/60"
                        >
                          <Avatar name={contact.fullName} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-body">
                              {contact.fullName}
                            </span>
                            <span className="block truncate text-[11px] text-faint">
                              {contact.company?.name ?? contact.jobTitle ?? "No company"}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 text-[11px] ${overdue ? "font-medium text-rose-600 dark:text-rose-400" : "text-faint"}`}
                          >
                            {overdue
                              ? "Overdue"
                              : since === null
                                ? "Never"
                                : `${since}d`}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            {/* Opportunities */}
            <Panel>
              <PanelHeader
                title="Deadlines ahead"
                icon={<Landmark />}
                action={
                  <Button asChild size="xs" variant="ghost">
                    <Link href="/opportunities">All</Link>
                  </Button>
                }
              />
              {dashboard.opportunities.length === 0 ? (
                <EmptyState compact title="No deadlines in the next 30 days" />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {dashboard.opportunities.map((opp) => {
                    const deadline = describeDeadline(opp.deadlineAt);
                    return (
                      <li key={opp.id}>
                        <Link
                          href={`/opportunities/${opp.id}`}
                          className="block px-4 py-3 transition-colors hover:bg-sunken/60"
                        >
                          <p className="truncate text-[13px] font-medium text-body">{opp.name}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span
                              className={`text-[11px] ${deadline.urgent ? "font-medium text-amber-600 dark:text-amber-400" : "text-faint"}`}
                            >
                              {deadline.label}
                            </span>
                            <span className="text-[11px] text-faint">· {formatMoney(opp.estimatedValueCents)}</span>
                            <Badge tone={SUBMISSION_STATUS.tone(opp.submissionStatus)}>
                              {SUBMISSION_STATUS.label(opp.submissionStatus)}
                            </Badge>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            {/* Closing soon */}
            {dashboard.closingDeals.length > 0 ? (
              <Panel>
                <PanelHeader title="Closing in 30 days" icon={<TrendingUp />} />
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {dashboard.closingDeals.map((deal) => (
                    <li key={deal.id}>
                      <Link
                        href={`/deals/${deal.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-sunken/60"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-body">{deal.name}</span>
                          <DotLabel color={deal.stage.color} className="mt-0.5 text-[11px] text-faint">
                            {deal.stage.name} · {formatDay(deal.expectedCloseAt)}
                          </DotLabel>
                        </span>
                        <span className="shrink-0 text-[13px] font-medium tabular text-body">
                          {formatCompact(deal.valueCents)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

/**
 * Streamed separately: the brief may call a model, and nothing else on the page
 * should wait for it.
 */
async function BriefBlock({ scope, scopeCookie }: { scope: string; scopeCookie: string }) {
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(scopeCookie);
  const workspaces = actor.memberships;
  const brief = await getDailyBrief(actor, {
    workspaceIds,
    workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])),
  });

  return (
    <DailyBrief
      greeting={`${greeting()}.`}
      body={brief.body}
      generatedAt={brief.generatedAt.toISOString()}
      providerLabel={describeProvider().label}
      scope={scope}
    />
  );
}

function BriefSkeleton() {
  return (
    <div className="rounded-xl border border-hairline bg-panel p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-2.5 w-56" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full max-w-2xl" />
        <Skeleton className="h-3 w-full max-w-xl" />
        <Skeleton className="h-3 w-full max-w-lg" />
      </div>
    </div>
  );
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function momentumTone(momentum: string) {
  return momentum === "stalled" ? TONE.rose : TONE.amber;
}
