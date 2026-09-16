import "server-only";
import { POST_SUBMISSION_STATUSES, TERMINAL_SUBMISSION_STATUSES } from "@/lib/enums";

import type { ReadScope } from "@/lib/auth/access";
import { meetsProjectTarget } from "@/lib/rfp-lifecycle";
import { withTenantContext } from "@/lib/tenant-db";
import { db } from "@/lib/db";
import { scoreDeal, scoreProjectHealth } from "@/lib/scoring";

/**
 * The home dashboard's data.
 *
 * Everything is bounded and indexed: counts are aggregate queries, lists are
 * `take`-limited, and no query loads a whole table. The dashboard costs the same
 * whether a workspace holds 30 contacts or 30,000.
 */
export async function getDashboard(read: ReadScope, projectFocus: string | null) {
  const { workspaceIds } = read;
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext(read, async () => {
    const where = { workspaceId: { in: workspaceIds } };
    const projectFilter = projectFocus ? { projectId: projectFocus } : {};
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const in7 = new Date(now.getTime() + 7 * 86_400_000);
    const in30 = new Date(now.getTime() + 30 * 86_400_000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      openDeals, wonThisMonth, tasksToday, overdueTasks, activeProjects,
      projectsRaw, contactsToFollowUp, opportunities, awaitingDecision, recentActivity,
      upcomingEvents, closingDeals, dealsForScoring, completedThisMonth,
    ] = await Promise.all([
      db.deal.aggregate({
        where: { ...where, ...projectFilter, archivedAt: null, stage: { kind: "open" } },
        _sum: { valueCents: true },
        _count: true,
      }),
      db.deal.aggregate({
        where: { ...where, archivedAt: null, stage: { kind: "won" }, closedAt: { gte: monthStart } },
        _sum: { valueCents: true },
        _count: true,
      }),
      db.task.count({
        where: {
          ...where, ...projectFilter,
          status: { in: ["open", "in_progress"] },
          dueAt: { gte: now, lte: endOfToday },
        },
      }),
      db.task.count({
        where: {
          ...where, ...projectFilter,
          status: { in: ["open", "in_progress"] },
          dueAt: { lt: now },
        },
      }),
      db.project.count({ where: { ...where, archivedAt: null, status: { isTerminal: false } } }),
      db.project.findMany({
        where: {
          ...where, archivedAt: null, status: { isTerminal: false },
          ...(projectFocus ? { id: projectFocus } : {}),
        },
        select: {
          id: true, name: true, health: true, targetDate: true, nextAction: true,
          nextActionDueAt: true, lastActivityAt: true, completedAt: true,
          budgetCents: true, revenueCents: true, priority: true,
          company: { select: { id: true, name: true } },
          status: { select: { name: true, color: true, isTerminal: true } },
          milestones: { select: { completedAt: true, dueDate: true } },
          tasks: { where: { status: { in: ["open", "in_progress"] } }, select: { dueAt: true } },
          opportunities: { where: { archivedAt: null }, select: { id: true, submissionStatus: true, submittedAt: true, proposalDeadlineAt: true, decisionExpectedAt: true, decidedAt: true } },
        },
        orderBy: { targetDate: "asc" },
        take: 40,
      }),
      db.contact.findMany({
        where: {
          ...where, archivedAt: null,
          OR: [
            { nextFollowUpAt: { lte: endOfToday } },
            { lastContactedAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } },
            { AND: [{ lastContactedAt: null }, { createdAt: { lte: new Date(now.getTime() - 7 * 86_400_000) } }] },
          ],
        },
        select: {
          id: true, fullName: true, jobTitle: true, lastContactedAt: true, nextFollowUpAt: true,
          company: { select: { id: true, name: true } },
          _count: { select: { deals: true } },
        },
        orderBy: [{ nextFollowUpAt: "asc" }, { lastContactedAt: "asc" }],
        take: 8,
      }),
      // Work still to do before a deadline. A proposal that is already in is not
      // work — including one submitted early, whose deadline is still ahead and
      // which used to sit here looking urgent.
      db.opportunity.findMany({
        where: {
          ...where, archivedAt: null,
          submissionStatus: {
            notIn: [...TERMINAL_SUBMISSION_STATUSES, ...POST_SUBMISSION_STATUSES],
          },
          deadlineAt: { gte: now, lte: in30 },
        },
        select: {
          id: true, name: true, deadlineAt: true, questionsDeadlineAt: true, proposalDeadlineAt: true,
          submittedAt: true, decisionExpectedAt: true, decidedAt: true,
          estimatedValueCents: true, fitScore: true, submissionStatus: true, type: true,
          company: { select: { name: true } },
        },
        orderBy: { deadlineAt: "asc" },
        take: 6,
      }),
      // Proposals that are in, waiting on somebody else. A different queue,
      // because there is nothing to do here but wait — ordered by when a
      // decision is expected, and by the oldest submission when it is not known.
      db.opportunity.findMany({
        where: {
          ...where, archivedAt: null,
          submissionStatus: { in: [...POST_SUBMISSION_STATUSES] },
        },
        select: {
          id: true, name: true, deadlineAt: true, proposalDeadlineAt: true,
          submittedAt: true, decisionExpectedAt: true, decidedAt: true,
          estimatedValueCents: true, submissionStatus: true, type: true,
          company: { select: { name: true } },
        },
        orderBy: [{ decisionExpectedAt: "asc" }, { submittedAt: "asc" }],
        take: 6,
      }),
      db.activity.findMany({
        where: { ...where, ...(projectFocus ? { projectId: projectFocus } : {}) },
        select: {
          id: true, type: true, title: true, body: true, occurredAt: true, direction: true,
          noteId: true, note: { select: { archivedAt: true } },
          contact: { select: { id: true, fullName: true } },
          company: { select: { id: true, name: true } },
          deal: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
          actor: { select: { name: true, avatarUrl: true } },
        },
        orderBy: { occurredAt: "desc" },
        take: 12,
      }),
      db.calendarEvent.findMany({
        where: { ...where, startAt: { gte: now, lte: in7 } },
        select: {
          id: true, title: true, startAt: true, endAt: true, meetingUrl: true,
          contact: { select: { id: true, fullName: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { startAt: "asc" },
        take: 6,
      }),
      db.deal.findMany({
        where: {
          ...where, archivedAt: null, stage: { kind: "open" },
          expectedCloseAt: { gte: now, lte: in30 },
        },
        select: {
          id: true, name: true, valueCents: true, expectedCloseAt: true,
          company: { select: { name: true } },
          stage: { select: { name: true, probability: true, color: true } },
        },
        orderBy: { expectedCloseAt: "asc" },
        take: 6,
      }),
      db.deal.findMany({
        where: { ...where, ...projectFilter, archivedAt: null, stage: { kind: "open" } },
        select: {
          id: true, name: true, valueCents: true, expectedCloseAt: true, nextStep: true,
          createdAt: true, stageEnteredAt: true, lastActivityAt: true,
          company: { select: { id: true, name: true } },
          stage: {
            select: {
              name: true, probability: true, order: true, color: true,
              pipeline: { select: { _count: { select: { stages: true } } } },
            },
          },
          _count: { select: { contacts: true, tasks: true } },
        },
        orderBy: { valueCents: "desc" },
        take: 30,
      }),
      db.task.count({
        where: { ...where, status: "done", completedAt: { gte: monthStart } },
      }),
    ]);

    // Health is computed, never trusted from the stored column, so it reflects
    // the data as it stands right now.
    const projects = projectsRaw.map((p) => {
      const overdueTasks = p.tasks.filter((t) => t.dueAt && t.dueAt < now).length;
      const targetMet = meetsProjectTarget(p.targetDate, p.opportunities);
      const health = scoreProjectHealth({
        targetDate: p.targetDate,
        completedAt: p.completedAt,
        lastActivityAt: p.lastActivityAt,
        isTerminalStatus: p.status?.isTerminal ?? false,
        overdueTasks,
        openTasks: p.tasks.length,
        totalMilestones: p.milestones.length,
        completedMilestones: p.milestones.filter((m) => m.completedAt).length,
        overdueMilestones: p.milestones.filter((m) => !m.completedAt && m.dueDate && m.dueDate < now).length,
        budgetCents: p.budgetCents,
        revenueCents: p.revenueCents,
        hasNextAction: Boolean(p.nextAction),
        targetMetBySubmission: targetMet,
      });
      return { ...p, computedHealth: health, overdueTasks, targetMet };
    });

    const scoredDeals = dealsForScoring.map((d) => {
      const stageCount = d.stage.pipeline._count.stages || 1;
      const intel = scoreDeal({
        createdAt: d.createdAt,
        stageEnteredAt: d.stageEnteredAt,
        lastActivityAt: d.lastActivityAt,
        expectedCloseAt: d.expectedCloseAt,
        stageProgress: d.stage.order / stageCount,
        stageProbability: d.stage.probability,
        stageKind: "open",
        valueCents: d.valueCents,
        activities30d: 0,
        inbound30d: 0,
        meetings30d: 0,
        openTasks: d._count.tasks,
        hasNextStep: Boolean(d.nextStep),
        contactCount: d._count.contacts,
      });
      return { ...d, intel };
    });

    // Weighted forecast: value × calibrated win probability, not raw pipeline.
    const forecastCents = scoredDeals.reduce(
      (total, d) => total + Math.round((d.valueCents * d.intel.winProbability) / 100),
      0,
    );

    return {
      pipeline: {
        valueCents: openDeals._sum.valueCents ?? 0,
        count: openDeals._count,
        forecastCents,
      },
      won: { valueCents: wonThisMonth._sum.valueCents ?? 0, count: wonThisMonth._count },
      tasks: { today: tasksToday, overdue: overdueTasks, completedThisMonth },
      projects: {
        active: activeProjects,
        atRisk: projects.filter((p) => p.computedHealth.value !== "on_track").length,
        list: projects,
      },
      contactsToFollowUp,
      opportunities,
      awaitingDecision,
      recentActivity,
      upcomingEvents,
      closingDeals,
      needsAttention: scoredDeals
        .filter((d) => d.intel.momentum.value === "stalled" || d.intel.momentum.value === "slowing")
        .slice(0, 5),
    };
  });
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;
