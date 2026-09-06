import "server-only";

import { contains, db, isSearchable } from "@/lib/db";
import type { EntityType } from "@/lib/enums";

export type SearchHit = {
  id: string;
  type: EntityType;
  title: string;
  subtitle?: string | null;
  href: string;
  workspaceId: string;
  /** Lower is better. Used to order across categories. */
  rank: number;
};

/**
 * Cross-entity search.
 *
 * Deliberately built on indexed `contains` queries rather than an in-memory
 * fuzzy pass: at a few thousand contacts the database can answer this in a few
 * milliseconds, and the ranking below (prefix beats substring, name beats body)
 * gives most of the benefit of fuzzy matching without loading the table.
 *
 * If a workspace ever outgrows this, the swap is to Postgres full-text or an
 * external index — the call sites only depend on the SearchHit shape.
 */
export async function searchEverything(
  workspaceIds: string[],
  query: string,
  limitPerType = 5,
): Promise<SearchHit[]> {
  const q = query.trim();
  // A wildcard-only term matches every row on both engines, so it is treated as
  // no search rather than as the most expensive query in the product.
  if (!isSearchable(q) || workspaceIds.length === 0) return [];

  const scope = { workspaceId: { in: workspaceIds } };
  const like = contains(q);

  const [contacts, companies, deals, projects, opportunities, tasks, notes] = await Promise.all([
    db.contact.findMany({
      where: {
        ...scope, archivedAt: null,
        OR: [{ fullName: like }, { email: like }, { jobTitle: like }],
      },
      select: { id: true, fullName: true, jobTitle: true, workspaceId: true, company: { select: { name: true } } },
      take: limitPerType * 2,
    }),
    db.company.findMany({
      where: { ...scope, archivedAt: null, OR: [{ name: like }, { domain: like }, { industry: like }] },
      select: { id: true, name: true, industry: true, workspaceId: true },
      take: limitPerType * 2,
    }),
    db.deal.findMany({
      where: { ...scope, archivedAt: null, OR: [{ name: like }, { nextStep: like }] },
      select: {
        id: true, name: true, valueCents: true, workspaceId: true,
        company: { select: { name: true } }, stage: { select: { name: true } },
      },
      take: limitPerType * 2,
    }),
    db.project.findMany({
      where: { ...scope, archivedAt: null, OR: [{ name: like }, { description: like }] },
      select: {
        id: true, name: true, workspaceId: true,
        company: { select: { name: true } }, status: { select: { name: true } },
      },
      take: limitPerType * 2,
    }),
    db.opportunity.findMany({
      where: {
        ...scope, archivedAt: null,
        OR: [{ name: like }, { solicitationNumber: like }, { requirements: like }],
      },
      select: { id: true, name: true, type: true, workspaceId: true, company: { select: { name: true } } },
      take: limitPerType * 2,
    }),
    db.task.findMany({
      where: { ...scope, OR: [{ title: like }, { description: like }] },
      select: { id: true, title: true, status: true, dueAt: true, workspaceId: true },
      take: limitPerType * 2,
    }),
    db.note.findMany({
      where: { ...scope, OR: [{ title: like }, { plainText: like }] },
      select: { id: true, title: true, plainText: true, workspaceId: true },
      take: limitPerType * 2,
    }),
  ]);

  const lower = q.toLowerCase();
  /** Prefix matches rank above substring matches; shorter titles win ties. */
  const rankOf = (text: string, base: number) => {
    const t = text.toLowerCase();
    if (t === lower) return base;
    if (t.startsWith(lower)) return base + 1;
    if (t.includes(lower)) return base + 2;
    return base + 3;
  };

  const hits: SearchHit[] = [
    ...contacts.map((c) => ({
      id: c.id, type: "contact" as const, title: c.fullName,
      subtitle: [c.jobTitle, c.company?.name].filter(Boolean).join(" · ") || null,
      href: `/contacts/${c.id}`, workspaceId: c.workspaceId, rank: rankOf(c.fullName, 0),
    })),
    ...companies.map((c) => ({
      id: c.id, type: "company" as const, title: c.name, subtitle: c.industry,
      href: `/companies/${c.id}`, workspaceId: c.workspaceId, rank: rankOf(c.name, 0),
    })),
    ...deals.map((d) => ({
      id: d.id, type: "deal" as const, title: d.name,
      subtitle: [d.company?.name, d.stage.name].filter(Boolean).join(" · ") || null,
      href: `/deals/${d.id}`, workspaceId: d.workspaceId, rank: rankOf(d.name, 0),
    })),
    ...projects.map((p) => ({
      id: p.id, type: "project" as const, title: p.name,
      subtitle: [p.company?.name, p.status?.name].filter(Boolean).join(" · ") || null,
      href: `/projects/${p.id}`, workspaceId: p.workspaceId, rank: rankOf(p.name, 0),
    })),
    ...opportunities.map((o) => ({
      id: o.id, type: "opportunity" as const, title: o.name, subtitle: o.company?.name ?? null,
      href: `/opportunities/${o.id}`, workspaceId: o.workspaceId, rank: rankOf(o.name, 0),
    })),
    ...tasks.map((t) => ({
      id: t.id, type: "task" as const, title: t.title,
      subtitle: t.status === "done" ? "Completed" : null,
      href: `/tasks?task=${t.id}`, workspaceId: t.workspaceId, rank: rankOf(t.title, 1),
    })),
    ...notes.map((n) => ({
      id: n.id, type: "note" as const, title: n.title || "Untitled note",
      subtitle: n.plainText.slice(0, 80) || null,
      href: `/notes/${n.id}`, workspaceId: n.workspaceId,
      rank: rankOf(n.title || n.plainText.slice(0, 60), 1),
    })),
  ];

  return hits.sort((a, b) => a.rank - b.rank || a.title.length - b.title.length);
}
