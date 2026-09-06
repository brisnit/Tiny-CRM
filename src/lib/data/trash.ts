import "server-only";

import { contains, db, isSearchable } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Trash: the archived records of a workspace, with everything needed to restore
 * one.
 *
 * Archiving already existed and was already reversible. What was missing was a
 * *place to see it from*: a record archived by mistake vanished from every list
 * and there was no screen that would show it again. A reversible action nobody
 * can find is not reversible in practice.
 *
 * The rows are read across six entity types in one pass so the screen can be a
 * single chronological list — "what disappeared, and when" — rather than six
 * tabs the user has to guess between.
 */

export const TRASHABLE = [
  "contact", "company", "deal", "project", "opportunity", "note",
] as const;
export type TrashableType = (typeof TRASHABLE)[number];

export type TrashItem = {
  id: string;
  type: TrashableType;
  label: string;
  detail: string | null;
  workspaceId: string;
  workspaceName: string;
  archivedAt: Date;
  /** Days until this is eligible for permanent removal, if a policy is set. */
  daysArchived: number;
};

export type TrashFilters = {
  q?: string;
  type?: TrashableType;
  limit?: number;
};

/**
 * Lists archived records across the given workspaces.
 *
 * Six queries in parallel rather than a union view: the tables have different
 * columns, and a view would have to be maintained alongside the schema. At trash
 * scale — tens to hundreds of rows — six indexed reads are not the bottleneck.
 */
export async function listTrash(
  workspaceIds: string[],
  filters: TrashFilters = {},
): Promise<{ items: TrashItem[]; countsByType: Record<TrashableType, number> }> {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    if (workspaceIds.length === 0) {
      return { items: [], countsByType: emptyCounts() };
    }

    const take = Math.min(filters.limit ?? 100, 200);
    const scope = { workspaceId: { in: workspaceIds }, archivedAt: { not: null } };
    const q = isSearchable(filters.q) ? filters.q : undefined;

    const wanted = (type: TrashableType) => !filters.type || filters.type === type;

    const [contacts, companies, deals, projects, opportunities, notes, workspaces] =
      await Promise.all([
        wanted("contact")
          ? db.contact.findMany({
              where: { ...scope, ...(q ? { fullName: contains(q) } : {}) },
              select: { id: true, fullName: true, jobTitle: true, workspaceId: true, archivedAt: true },
              orderBy: { archivedAt: "desc" },
              take,
            })
          : [],
        wanted("company")
          ? db.company.findMany({
              where: { ...scope, ...(q ? { name: contains(q) } : {}) },
              select: { id: true, name: true, industry: true, workspaceId: true, archivedAt: true },
              orderBy: { archivedAt: "desc" },
              take,
            })
          : [],
        wanted("deal")
          ? db.deal.findMany({
              where: { ...scope, ...(q ? { name: contains(q) } : {}) },
              select: { id: true, name: true, valueCents: true, workspaceId: true, archivedAt: true },
              orderBy: { archivedAt: "desc" },
              take,
            })
          : [],
        wanted("project")
          ? db.project.findMany({
              where: { ...scope, ...(q ? { name: contains(q) } : {}) },
              select: { id: true, name: true, type: true, workspaceId: true, archivedAt: true },
              orderBy: { archivedAt: "desc" },
              take,
            })
          : [],
        wanted("opportunity")
          ? db.opportunity.findMany({
              where: { ...scope, ...(q ? { name: contains(q) } : {}) },
              select: { id: true, name: true, type: true, workspaceId: true, archivedAt: true },
              orderBy: { archivedAt: "desc" },
              take,
            })
          : [],
        wanted("note")
          ? db.note.findMany({
              where: { ...scope, ...(q ? { title: contains(q) } : {}) },
              select: { id: true, title: true, plainText: true, workspaceId: true, archivedAt: true },
              orderBy: { archivedAt: "desc" },
              take,
            })
          : [],
        db.workspace.findMany({
          where: { id: { in: workspaceIds } },
          select: { id: true, name: true },
        }),
      ]);

    const names = new Map(workspaces.map((w) => [w.id, w.name]));
    const now = Date.now();
    const days = (at: Date) => Math.floor((now - at.getTime()) / 86_400_000);

    const items: TrashItem[] = [
      ...contacts.map((c) => ({
        id: c.id, type: "contact" as const, label: c.fullName, detail: c.jobTitle,
        workspaceId: c.workspaceId, workspaceName: names.get(c.workspaceId) ?? "",
        archivedAt: c.archivedAt!, daysArchived: days(c.archivedAt!),
      })),
      ...companies.map((c) => ({
        id: c.id, type: "company" as const, label: c.name, detail: c.industry,
        workspaceId: c.workspaceId, workspaceName: names.get(c.workspaceId) ?? "",
        archivedAt: c.archivedAt!, daysArchived: days(c.archivedAt!),
      })),
      ...deals.map((d) => ({
        id: d.id, type: "deal" as const, label: d.name,
        detail: d.valueCents ? `$${(d.valueCents / 100).toLocaleString()}` : null,
        workspaceId: d.workspaceId, workspaceName: names.get(d.workspaceId) ?? "",
        archivedAt: d.archivedAt!, daysArchived: days(d.archivedAt!),
      })),
      ...projects.map((p) => ({
        id: p.id, type: "project" as const, label: p.name, detail: p.type,
        workspaceId: p.workspaceId, workspaceName: names.get(p.workspaceId) ?? "",
        archivedAt: p.archivedAt!, daysArchived: days(p.archivedAt!),
      })),
      ...opportunities.map((o) => ({
        id: o.id, type: "opportunity" as const, label: o.name, detail: o.type,
        workspaceId: o.workspaceId, workspaceName: names.get(o.workspaceId) ?? "",
        archivedAt: o.archivedAt!, daysArchived: days(o.archivedAt!),
      })),
      ...notes.map((n) => ({
        id: n.id, type: "note" as const,
        label: n.title ?? n.plainText.slice(0, 60) ?? "Untitled note",
        detail: null,
        workspaceId: n.workspaceId, workspaceName: names.get(n.workspaceId) ?? "",
        archivedAt: n.archivedAt!, daysArchived: days(n.archivedAt!),
      })),
    ]
      .sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime())
      .slice(0, take);

    const countsByType = emptyCounts();
    countsByType.contact = contacts.length;
    countsByType.company = companies.length;
    countsByType.deal = deals.length;
    countsByType.project = projects.length;
    countsByType.opportunity = opportunities.length;
    countsByType.note = notes.length;

    return { items, countsByType };
  });
}

function emptyCounts(): Record<TrashableType, number> {
  return { contact: 0, company: 0, deal: 0, project: 0, opportunity: 0, note: 0 };
}
