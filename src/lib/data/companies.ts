import "server-only";

import { contains, db } from "@/lib/db";
import { tagsForEntities } from "@/lib/actions/tags";

const PAGE_SIZE = 50;

export async function listCompanies(
  workspaceIds: string[],
  filters: { q?: string; type?: string; relationshipStatus?: string; tag?: string; view?: string; page?: number },
) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Record<string, unknown> = { workspaceId: { in: workspaceIds }, archivedAt: null };

  if (filters.q) {
    where.OR = [
      { name: contains(filters.q) },
      { domain: contains(filters.q) },
      { industry: contains(filters.q) },
      { location: contains(filters.q) },
    ];
  }
  if (filters.type) where.type = filters.type;
  if (filters.relationshipStatus) where.relationshipStatus = filters.relationshipStatus;
  if (filters.view === "clients") where.type = "client";
  if (filters.view === "quiet") {
    where.lastActivityAt = { lte: new Date(Date.now() - 30 * 86_400_000) };
  }
  if (filters.tag) {
    const links = await db.tagLink.findMany({
      where: { entityType: "company", tag: { name: filters.tag, workspaceId: { in: workspaceIds } } },
      select: { entityId: true },
    });
    where.id = { in: links.map((l) => l.entityId) };
  }

  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      select: {
        id: true, name: true, industry: true, location: true, website: true, size: true,
        type: true, relationshipStatus: true, lastActivityAt: true, workspaceId: true,
        primaryContact: { select: { id: true, fullName: true } },
        _count: { select: { contacts: true, deals: true, projects: true } },
      },
      orderBy: filters.view === "quiet" ? { lastActivityAt: "asc" } : { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.company.count({ where }),
  ]);

  // Open pipeline per company, in one grouped query rather than one per row.
  const pipelines = await db.deal.groupBy({
    by: ["companyId"],
    where: {
      companyId: { in: rows.map((r) => r.id) },
      archivedAt: null,
      stage: { kind: "open" },
    },
    _sum: { valueCents: true },
    _count: { _all: true },
  });
  const pipelineBy = new Map(
    pipelines.map((p) => [p.companyId, { value: p._sum.valueCents ?? 0, count: p._count._all }]),
  );

  const tags = await tagsForEntities("company", rows.map((r) => r.id));

  return {
    companies: rows.map((c) => ({
      ...c,
      pipeline: pipelineBy.get(c.id) ?? { value: 0, count: 0 },
      tags: tags.get(c.id) ?? [],
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getCompany(workspaceIds: string[], id: string) {
  const company = await db.company.findFirst({
    where: { id, workspaceId: { in: workspaceIds } },
    include: {
      workspace: { select: { id: true, name: true, color: true } },
      owner: { select: { id: true, name: true } },
      primaryContact: { select: { id: true, fullName: true, jobTitle: true, email: true } },
      contacts: {
        select: {
          id: true, fullName: true, jobTitle: true, email: true, lastContactedAt: true,
          relationshipType: true,
        },
        orderBy: { fullName: "asc" },
        take: 30,
      },
      deals: {
        select: {
          id: true, name: true, valueCents: true, expectedCloseAt: true,
          stage: { select: { name: true, color: true, kind: true } },
        },
        orderBy: { valueCents: "desc" },
        take: 20,
      },
      projects: {
        select: {
          id: true, name: true, health: true, targetDate: true, revenueCents: true,
          status: { select: { name: true, color: true } },
        },
        orderBy: { targetDate: "asc" },
        take: 20,
      },
      opportunities: {
        select: { id: true, name: true, deadlineAt: true, submissionStatus: true, estimatedValueCents: true },
        orderBy: { deadlineAt: "asc" },
        take: 10,
      },
      tasks: {
        where: { status: { in: ["open", "in_progress"] } },
        select: {
          id: true, title: true, dueAt: true, priority: true, status: true,
          project: { select: { id: true, name: true } },
        },
        orderBy: { dueAt: "asc" },
        take: 10,
      },
      notes: {
        select: { id: true, title: true, plainText: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 6,
      },
      activities: {
        select: {
          id: true, type: true, title: true, body: true, direction: true, durationMin: true,
          occurredAt: true,
          contact: { select: { id: true, fullName: true } },
          deal: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { occurredAt: "desc" },
        take: 30,
      },
      files: {
        select: { id: true, name: true, sizeBytes: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 8,
      },
    },
  });

  if (!company) return null;
  const tags = await tagsForEntities("company", [id]);

  const openDeals = company.deals.filter((d) => d.stage.kind === "open");
  const wonDeals = company.deals.filter((d) => d.stage.kind === "won");

  return {
    ...company,
    tags: tags.get(id) ?? [],
    stats: {
      openPipelineCents: openDeals.reduce((sum, d) => sum + d.valueCents, 0),
      wonCents: wonDeals.reduce((sum, d) => sum + d.valueCents, 0),
      revenueCents: company.projects.reduce((sum, p) => sum + (p.revenueCents ?? 0), 0),
      openDealCount: openDeals.length,
    },
  };
}
