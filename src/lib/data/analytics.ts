import "server-only";

import { db } from "@/lib/db";

/**
 * Analytics.
 *
 * Every figure is derived from the same records the rest of the app uses — there
 * is no separate reporting store to drift out of sync. Aggregations run in SQL
 * where the shape allows; the month buckets are built in one pass over a bounded
 * set of closed deals rather than a query per month.
 */

export type AnalyticsRange = 30 | 90 | 180 | 365;

export async function getAnalytics(workspaceIds: string[], days: AnalyticsRange = 90) {
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const where = { workspaceId: { in: workspaceIds } };

  const [
    openAgg, wonAgg, lostAgg, createdCount, stageBreakdown, closedDeals,
    createdDeals, leadSources, contactsAdded, projectStats, taskStats,
    opportunityAgg, pipelineStages,
  ] = await Promise.all([
    db.deal.aggregate({
      where: { ...where, archivedAt: null, stage: { kind: "open" } },
      _sum: { valueCents: true },
      _count: true,
      _avg: { valueCents: true },
    }),
    db.deal.aggregate({
      where: { ...where, archivedAt: null, stage: { kind: "won" }, closedAt: { gte: since } },
      _sum: { valueCents: true },
      _count: true,
      _avg: { valueCents: true },
    }),
    db.deal.aggregate({
      where: { ...where, archivedAt: null, stage: { kind: "lost" }, closedAt: { gte: since } },
      _sum: { valueCents: true },
      _count: true,
    }),
    db.deal.count({ where: { ...where, createdAt: { gte: since } } }),
    db.deal.groupBy({
      by: ["stageId"],
      where: { ...where, archivedAt: null, stage: { kind: "open" } },
      _sum: { valueCents: true },
      _count: { _all: true },
    }),
    db.deal.findMany({
      where: { ...where, archivedAt: null, closedAt: { gte: since }, stage: { kind: { in: ["won", "lost"] } } },
      select: {
        id: true, valueCents: true, closedAt: true, createdAt: true, source: true,
        stage: { select: { kind: true } },
      },
    }),
    db.deal.findMany({
      where: { ...where, createdAt: { gte: since } },
      select: { id: true, createdAt: true, valueCents: true },
    }),
    db.deal.groupBy({
      by: ["source"],
      where: { ...where, archivedAt: null, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { valueCents: true },
    }),
    db.contact.count({ where: { ...where, createdAt: { gte: since } } }),
    Promise.all([
      db.project.count({ where: { ...where, archivedAt: null, status: { isTerminal: false } } }),
      db.project.count({ where: { ...where, status: { isTerminal: true } } }),
      db.project.aggregate({ where: { ...where, archivedAt: null }, _sum: { revenueCents: true } }),
    ]),
    Promise.all([
      db.task.count({ where: { ...where, status: "done", completedAt: { gte: since } } }),
      db.task.count({
        where: { ...where, status: { in: ["open", "in_progress"] }, dueAt: { lt: now } },
      }),
    ]),
    db.opportunity.aggregate({
      where: { ...where, archivedAt: null, submissionStatus: { notIn: ["won", "lost", "no_bid"] } },
      _sum: { estimatedValueCents: true },
      _count: true,
    }),
    db.pipelineStage.findMany({
      where: { pipeline: { workspaceId: { in: workspaceIds }, kind: "deal" } },
      select: { id: true, name: true, order: true, kind: true, probability: true },
      orderBy: { order: "asc" },
    }),
  ]);

  const won = closedDeals.filter((d) => d.stage.kind === "won");
  const lost = closedDeals.filter((d) => d.stage.kind === "lost");
  const closedCount = won.length + lost.length;

  // Average sales cycle, in days, over deals actually closed in the window.
  const cycles = won
    .filter((d) => d.closedAt)
    .map((d) => (d.closedAt!.getTime() - d.createdAt.getTime()) / 86_400_000);
  const avgCycleDays = cycles.length > 0 ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;

  // Month buckets. Built from already-fetched rows so this stays one pass.
  const monthKeys = monthsBetween(since, now);
  const byMonth = new Map(
    monthKeys.map((key) => [key, { month: key, wonCents: 0, wonCount: 0, createdCount: 0, lostCount: 0 }]),
  );
  for (const deal of won) {
    const bucket = byMonth.get(monthKey(deal.closedAt!));
    if (bucket) {
      bucket.wonCents += deal.valueCents;
      bucket.wonCount += 1;
    }
  }
  for (const deal of lost) {
    const bucket = byMonth.get(monthKey(deal.closedAt!));
    if (bucket) bucket.lostCount += 1;
  }
  for (const deal of createdDeals) {
    const bucket = byMonth.get(monthKey(deal.createdAt));
    if (bucket) bucket.createdCount += 1;
  }

  const stageById = new Map(pipelineStages.map((s) => [s.id, s]));
  const funnel = stageBreakdown
    .map((row) => {
      const stage = stageById.get(row.stageId);
      return {
        name: stage?.name ?? "Unknown",
        order: stage?.order ?? 99,
        valueCents: row._sum.valueCents ?? 0,
        count: row._count._all,
      };
    })
    // Several workspaces can contribute a stage of the same name; merge them so
    // the All Businesses view reads as one funnel.
    .reduce<{ name: string; order: number; valueCents: number; count: number }[]>((acc, row) => {
      const existing = acc.find((r) => r.name === row.name);
      if (existing) {
        existing.valueCents += row.valueCents;
        existing.count += row.count;
      } else acc.push({ ...row });
      return acc;
    }, [])
    .sort((a, b) => a.order - b.order);

  const [activeProjects, completedProjects, projectRevenue] = projectStats;
  const [tasksCompleted, tasksOverdue] = taskStats;

  return {
    range: days,
    pipeline: {
      valueCents: openAgg._sum.valueCents ?? 0,
      count: openAgg._count,
      avgDealCents: Math.round(openAgg._avg.valueCents ?? 0),
    },
    won: {
      valueCents: wonAgg._sum.valueCents ?? 0,
      count: wonAgg._count,
      avgDealCents: Math.round(wonAgg._avg.valueCents ?? 0),
    },
    lost: { valueCents: lostAgg._sum.valueCents ?? 0, count: lostAgg._count },
    dealsCreated: createdCount,
    winRate: closedCount > 0 ? Math.round((won.length / closedCount) * 100) : null,
    avgCycleDays,
    funnel,
    months: Array.from(byMonth.values()),
    leadSources: leadSources
      .map((row) => ({
        source: row.source ?? "unknown",
        count: row._count._all,
        valueCents: row._sum.valueCents ?? 0,
      }))
      .sort((a, b) => b.count - a.count),
    contactsAdded,
    projects: {
      active: activeProjects,
      completed: completedProjects,
      revenueCents: projectRevenue._sum.revenueCents ?? 0,
    },
    tasks: { completed: tasksCompleted, overdue: tasksOverdue },
    opportunities: {
      valueCents: opportunityAgg._sum.estimatedValueCents ?? 0,
      count: opportunityAgg._count,
    },
  };
}

export type Analytics = Awaited<ReturnType<typeof getAnalytics>>;

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(from: Date, to: Date) {
  const keys: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cursor <= end) {
    keys.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}
