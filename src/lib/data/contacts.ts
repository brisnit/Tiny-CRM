import "server-only";

import { contains, db, isSearchable } from "@/lib/db";
import { scoreRelationship } from "@/lib/scoring";
import { tagsForEntities } from "@/lib/actions/tags";
import { withTenantContext } from "@/lib/tenant-db";

export type ContactFilters = {
  q?: string;
  relationshipType?: string;
  companyId?: string;
  tag?: string;
  view?: "all" | "follow_up" | "quiet" | "clients" | "new";
  sort?: "recent" | "name" | "oldest_contact" | "follow_up";
  page?: number;
};

const PAGE_SIZE = 50;

/**
 * The contacts list.
 *
 * Filtering and paging happen in SQL; only the current page's relationship
 * scores are computed, and their inputs come from one grouped aggregate rather
 * than a query per contact. That keeps the page O(page size) instead of
 * O(contacts).
 */
export async function listContacts(workspaceIds: string[], filters: ContactFilters) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    const now = new Date();
    const page = Math.max(1, filters.page ?? 1);

    const where: Record<string, unknown> = {
      workspaceId: { in: workspaceIds },
      archivedAt: null,
    };

    if (isSearchable(filters.q)) {
      where.OR = [
        { fullName: contains(filters.q) },
        { email: contains(filters.q) },
        { jobTitle: contains(filters.q) },
        { company: { name: contains(filters.q) } },
      ];
    }
    if (filters.relationshipType) where.relationshipType = filters.relationshipType;
    if (filters.companyId) where.companyId = filters.companyId;

    switch (filters.view) {
      case "follow_up":
        where.nextFollowUpAt = { lte: endOfDay(now) };
        break;
      case "quiet":
        where.OR = [
          { lastContactedAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } },
          { lastContactedAt: null },
        ];
        break;
      case "clients":
        where.relationshipType = "client";
        break;
      case "new":
        where.createdAt = { gte: new Date(now.getTime() - 14 * 86_400_000) };
        break;
    }

    if (filters.tag) {
      const links = await db.tagLink.findMany({
        where: { entityType: "contact", tag: { name: filters.tag, workspaceId: { in: workspaceIds } } },
        select: { entityId: true },
      });
      where.id = { in: links.map((l) => l.entityId) };
    }

    const orderBy =
      filters.sort === "name"
        ? { fullName: "asc" as const }
        : filters.sort === "oldest_contact"
          ? { lastContactedAt: "asc" as const }
          : filters.sort === "follow_up"
            ? { nextFollowUpAt: "asc" as const }
            : { updatedAt: "desc" as const };

    const [rows, total] = await Promise.all([
      db.contact.findMany({
        where,
        select: {
          id: true, fullName: true, jobTitle: true, email: true, phone: true, location: true,
          relationshipType: true, lastContactedAt: true, nextFollowUpAt: true, createdAt: true,
          importance: true, workspaceId: true,
          company: { select: { id: true, name: true } },
          owner: { select: { name: true, avatarUrl: true } },
          _count: { select: { deals: true, projects: true, tasks: true } },
        },
        orderBy,
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.contact.count({ where }),
    ]);

    const scored = await attachScores(rows, now);
    const tags = await tagsForEntities("contact", rows.map((r) => r.id));

    return {
      contacts: scored.map((c) => ({ ...c, tags: tags.get(c.id) ?? [] })),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      pageSize: PAGE_SIZE,
    };
  });
}

type ContactRow = {
  id: string;
  createdAt: Date;
  lastContactedAt: Date | null;
  nextFollowUpAt: Date | null;
  importance: number | null;
  _count: { deals: number };
};

/**
 * Computes relationship strength for a page of contacts using two grouped
 * queries rather than 2N per-contact queries.
 */
async function attachScores<T extends ContactRow>(rows: T[], now: Date) {
  if (rows.length === 0) return [] as (T & { relationship: ReturnType<typeof scoreRelationship> })[];

  const ids = rows.map((r) => r.id);
  const since = new Date(now.getTime() - 90 * 86_400_000);

  const [activityGroups, dealValues] = await Promise.all([
    db.activity.groupBy({
      by: ["contactId", "type", "direction"],
      where: { contactId: { in: ids }, occurredAt: { gte: since } },
      _count: { _all: true },
    }),
    db.dealContact.findMany({
      where: { contactId: { in: ids }, deal: { stage: { kind: "open" }, archivedAt: null } },
      select: { contactId: true, deal: { select: { valueCents: true } } },
    }),
  ]);

  const stats = new Map<string, { meetings: number; emails: number; calls: number; inbound: number }>();
  for (const group of activityGroups) {
    if (!group.contactId) continue;
    const entry = stats.get(group.contactId) ?? { meetings: 0, emails: 0, calls: 0, inbound: 0 };
    const count = group._count._all;
    if (group.type === "meeting") entry.meetings += count;
    if (group.type === "email") entry.emails += count;
    if (group.type === "call") entry.calls += count;
    if (group.direction === "inbound") entry.inbound += count;
    stats.set(group.contactId, entry);
  }

  const deals = new Map<string, { count: number; value: number }>();
  for (const link of dealValues) {
    const entry = deals.get(link.contactId) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += link.deal.valueCents;
    deals.set(link.contactId, entry);
  }

  return rows.map((row) => {
    const s = stats.get(row.id) ?? { meetings: 0, emails: 0, calls: 0, inbound: 0 };
    const d = deals.get(row.id) ?? { count: row._count.deals, value: 0 };
    return {
      ...row,
      relationship: scoreRelationship({
        createdAt: row.createdAt,
        lastContactedAt: row.lastContactedAt,
        nextFollowUpAt: row.nextFollowUpAt,
        meetings90d: s.meetings,
        emails90d: s.emails,
        calls90d: s.calls,
        inbound90d: s.inbound,
        openDealCount: d.count,
        openDealValueCents: d.value,
        importance: row.importance,
      }),
    };
  });
}

/** One contact with everything its page shows. */
export async function getContact(workspaceIds: string[], id: string) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    const contact = await db.contact.findFirst({
      where: { id, workspaceId: { in: workspaceIds } },
      include: {
        company: { select: { id: true, name: true, industry: true, website: true, logoUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        workspace: { select: { id: true, name: true, color: true } },
        deals: {
          include: {
            deal: {
              select: {
                id: true, name: true, valueCents: true, expectedCloseAt: true,
                stage: { select: { name: true, color: true, kind: true } },
              },
            },
          },
        },
        projects: {
          include: {
            project: {
              select: {
                id: true, name: true, health: true,
                status: { select: { name: true, color: true } },
              },
            },
          },
        },
        tasks: {
          where: { status: { in: ["open", "in_progress"] } },
          select: {
            id: true, title: true, dueAt: true, priority: true, status: true,
            project: { select: { id: true, name: true } },
            deal: { select: { id: true, name: true } },
          },
          orderBy: { dueAt: "asc" },
          take: 10,
        },
        notes: {
          select: { id: true, title: true, plainText: true, createdAt: true, pinned: true },
          orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
          take: 6,
        },
        activities: {
          select: {
            id: true, type: true, title: true, body: true, direction: true, durationMin: true,
            occurredAt: true,
            company: { select: { id: true, name: true } },
            deal: { select: { id: true, name: true } },
            project: { select: { id: true, name: true } },
          },
          orderBy: { occurredAt: "desc" },
          take: 30,
        },
        emails: {
          select: { id: true, subject: true, snippet: true, sentAt: true, direction: true, needsReply: true },
          orderBy: { sentAt: "desc" },
          take: 6,
        },
        events: {
          select: { id: true, title: true, startAt: true, meetingUrl: true },
          orderBy: { startAt: "desc" },
          take: 6,
        },
        files: {
          select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 6,
        },
      },
    });

    if (!contact) return null;

    const [scored] = await attachScores(
      [{ ...contact, _count: { deals: contact.deals.length } }],
      new Date(),
    );
    const tags = await tagsForEntities("contact", [id]);

    return { ...contact, relationship: scored!.relationship, tags: tags.get(id) ?? [] };
  });
}

function endOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}
