import "server-only";

import { contains, db, isSearchable } from "@/lib/db";
import { scoreDeal } from "@/lib/scoring";
import { tagsForEntities } from "@/lib/actions/tags";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Pipeline board data.
 *
 * Deals are fetched once and bucketed by stage in memory — one query rather
 * than one per column. A per-stage cap keeps a very full column from making the
 * page unbounded; the column header still shows the true total.
 */
export async function getPipelineBoard(
  workspaceIds: string[],
  options: { pipelineId?: string; q?: string; ownerOnly?: string; projectId?: string; kind?: "deal" | "opportunity" } = {},
) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    const kind = options.kind ?? "deal";

    const pipelines = await db.pipeline.findMany({
      where: { workspaceId: { in: workspaceIds }, kind },
      select: {
        id: true, name: true, workspaceId: true, description: true, isDefault: true,
        stages: {
          select: { id: true, name: true, order: true, probability: true, color: true, kind: true },
          orderBy: { order: "asc" },
        },
        workspace: { select: { name: true, color: true } },
      },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    });

    const active =
      pipelines.find((p) => p.id === options.pipelineId) ??
      pipelines.find((p) => p.isDefault) ??
      pipelines[0] ??
      null;

    if (!active) return { pipelines, active: null, columns: [], totals: { valueCents: 0, count: 0, forecastCents: 0 } };

    const where: Record<string, unknown> = {
      workspaceId: { in: workspaceIds },
      archivedAt: null,
      pipelineId: active.id,
    };
    if (isSearchable(options.q)) where.name = contains(options.q);
    if (options.projectId) where.projectId = options.projectId;

    const deals = await db.deal.findMany({
      where,
      select: {
        id: true, name: true, valueCents: true, expectedCloseAt: true, nextStep: true,
        createdAt: true, stageEnteredAt: true, lastActivityAt: true, stageId: true, probability: true,
        workspaceId: true,
        company: { select: { id: true, name: true } },
        primaryContact: { select: { id: true, fullName: true } },
        project: { select: { id: true, name: true } },
        stage: { select: { name: true, order: true, probability: true, kind: true, color: true } },
        _count: { select: { contacts: true, tasks: true } },
      },
      orderBy: [{ valueCents: "desc" }],
      take: 400,
    });

    const stageCount = active.stages.length || 1;
    const scored = deals.map((deal) => ({
      ...deal,
      intel: scoreDeal({
        createdAt: deal.createdAt,
        stageEnteredAt: deal.stageEnteredAt,
        lastActivityAt: deal.lastActivityAt,
        expectedCloseAt: deal.expectedCloseAt,
        stageProgress: deal.stage.order / stageCount,
        stageProbability: deal.probability ?? deal.stage.probability,
        stageKind: deal.stage.kind as "open" | "won" | "lost",
        valueCents: deal.valueCents,
        activities30d: 0,
        inbound30d: 0,
        meetings30d: 0,
        openTasks: deal._count.tasks,
        hasNextStep: Boolean(deal.nextStep),
        contactCount: deal._count.contacts,
      }),
    }));

    const columns = active.stages.map((stage) => {
      const items = scored.filter((d) => d.stageId === stage.id);
      return {
        stage,
        deals: items,
        valueCents: items.reduce((sum, d) => sum + d.valueCents, 0),
        count: items.length,
      };
    });

    const open = scored.filter((d) => d.stage.kind === "open");

    return {
      pipelines,
      active,
      columns,
      totals: {
        valueCents: open.reduce((sum, d) => sum + d.valueCents, 0),
        count: open.length,
        forecastCents: open.reduce(
          (sum, d) => sum + Math.round((d.valueCents * d.intel.winProbability) / 100),
          0,
        ),
      },
    };
  });
}

export async function getDeal(workspaceIds: string[], id: string) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    const deal = await db.deal.findFirst({
      where: { id, workspaceId: { in: workspaceIds } },
      include: {
        workspace: { select: { id: true, name: true } },
        company: { select: { id: true, name: true, industry: true } },
        primaryContact: { select: { id: true, fullName: true, jobTitle: true, email: true } },
        project: { select: { id: true, name: true, health: true } },
        owner: { select: { id: true, name: true } },
        pipeline: {
          select: {
            id: true, name: true,
            stages: {
              select: { id: true, name: true, order: true, probability: true, color: true, kind: true },
              orderBy: { order: "asc" },
            },
          },
        },
        stage: { select: { id: true, name: true, order: true, probability: true, color: true, kind: true } },
        contacts: {
          include: { contact: { select: { id: true, fullName: true, jobTitle: true, email: true } } },
        },
        tasks: {
          select: {
            id: true, title: true, dueAt: true, priority: true, status: true,
            contact: { select: { id: true, fullName: true } },
          },
          orderBy: [{ status: "asc" }, { dueAt: "asc" }],
          take: 15,
        },
        notes: {
          select: { id: true, title: true, plainText: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 6,
        },
        activities: {
          select: {
            id: true, type: true, title: true, body: true, direction: true, durationMin: true,
            occurredAt: true, meta: true,
            contact: { select: { id: true, fullName: true } },
            company: { select: { id: true, name: true } },
          },
          orderBy: { occurredAt: "desc" },
          take: 30,
        },
        files: {
          select: { id: true, name: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 8,
        },
        events: {
          select: { id: true, title: true, startAt: true },
          orderBy: { startAt: "desc" },
          take: 5,
        },
      },
    });

    if (!deal) return null;

    // Recompute momentum with real 30-day interaction counts for the detail view,
    // where the extra query is worth the precision.
    const since = new Date(Date.now() - 30 * 86_400_000);
    const groups = await db.activity.groupBy({
      by: ["type", "direction"],
      where: { dealId: id, occurredAt: { gte: since } },
      _count: { _all: true },
    });

    const activities30d = groups.reduce((sum, g) => sum + g._count._all, 0);
    const inbound30d = groups.filter((g) => g.direction === "inbound").reduce((s, g) => s + g._count._all, 0);
    const meetings30d = groups.filter((g) => g.type === "meeting").reduce((s, g) => s + g._count._all, 0);

    const intel = scoreDeal({
      createdAt: deal.createdAt,
      stageEnteredAt: deal.stageEnteredAt,
      lastActivityAt: deal.lastActivityAt,
      expectedCloseAt: deal.expectedCloseAt,
      stageProgress: deal.stage.order / (deal.pipeline.stages.length || 1),
      stageProbability: deal.probability ?? deal.stage.probability,
      stageKind: deal.stage.kind as "open" | "won" | "lost",
      valueCents: deal.valueCents,
      activities30d,
      inbound30d,
      meetings30d,
      openTasks: deal.tasks.filter((t) => t.status !== "done").length,
      hasNextStep: Boolean(deal.nextStep),
      contactCount: deal.contacts.length,
    });

    const tags = await tagsForEntities("deal", [id]);
    return { ...deal, intel, tags: tags.get(id) ?? [] };
  });
}
