import "server-only";

import type { ReadScope } from "@/lib/auth/access";
import { meetsProjectTarget } from "@/lib/rfp-lifecycle";
import { contains, db, isSearchable } from "@/lib/db";
import { scoreProjectHealth } from "@/lib/scoring";
import { tagsForEntities } from "@/lib/actions/tags";
import { withTenantContext } from "@/lib/tenant-db";

const PAGE_SIZE = 50;

export async function listProjects(
  read: ReadScope,
  filters: { q?: string; statusId?: string; type?: string; priority?: string; view?: string; page?: number },
) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  const { workspaceIds } = read;
  return withTenantContext(read, async () => {
    const now = new Date();
    const page = Math.max(1, filters.page ?? 1);
    const where: Record<string, unknown> = { workspaceId: { in: workspaceIds }, archivedAt: null };

    if (isSearchable(filters.q)) {
      where.OR = [
        { name: contains(filters.q) },
        { description: contains(filters.q) },
        { company: { name: contains(filters.q) } },
      ];
    }
    if (filters.statusId) where.statusId = filters.statusId;
    if (filters.type) where.type = filters.type;
    if (filters.priority) where.priority = filters.priority;

    if (filters.view === "active" || !filters.view || filters.view === "all") {
      if (filters.view !== "all") where.status = { isTerminal: false };
    }
    if (filters.view === "completed") where.status = { isTerminal: true };
    if (filters.view === "due_soon") {
      where.status = { isTerminal: false };
      where.targetDate = { gte: now, lte: new Date(now.getTime() + 30 * 86_400_000) };
    }

    const [rows, total, statuses] = await Promise.all([
      db.project.findMany({
        where,
        select: {
          id: true, name: true, priority: true, type: true, targetDate: true, startDate: true,
          budgetCents: true, revenueCents: true, nextAction: true, nextActionDueAt: true,
          opportunities: { where: { archivedAt: null }, select: { id: true, submissionStatus: true, submittedAt: true, proposalDeadlineAt: true, decisionExpectedAt: true, decidedAt: true } },
          lastActivityAt: true, completedAt: true, workspaceId: true,
          company: { select: { id: true, name: true } },
          status: { select: { id: true, name: true, color: true, isTerminal: true } },
          owner: { select: { name: true, avatarUrl: true } },
          milestones: { select: { completedAt: true, dueDate: true } },
          tasks: { where: { status: { in: ["open", "in_progress"] } }, select: { dueAt: true } },
          _count: { select: { contacts: true, deals: true, files: true } },
        },
        orderBy: { targetDate: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.project.count({ where }),
      db.projectStatus.findMany({
        where: { workspaceId: { in: workspaceIds } },
        select: { id: true, name: true, color: true, order: true },
        orderBy: { order: "asc" },
      }),
    ]);

    const projects = rows.map((p) => withHealth(p, now));
    const tags = await tagsForEntities("project", rows.map((r) => r.id));

    const filtered =
      filters.view === "at_risk"
        ? projects.filter((p) => p.health.value !== "on_track")
        : projects;

    return {
      projects: filtered.map((p) => ({ ...p, tags: tags.get(p.id) ?? [] })),
      statuses,
      total: filters.view === "at_risk" ? filtered.length : total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  });
}

type HealthInput = {
  targetDate: Date | null;
  completedAt: Date | null;
  lastActivityAt: Date | null;
  budgetCents: number | null;
  revenueCents: number | null;
  nextAction: string | null;
  status: { isTerminal: boolean } | null;
  milestones: { completedAt: Date | null; dueDate: Date | null }[];
  tasks: { dueAt: Date | null }[];
  /**
   * Linked RFPs, so health can tell a target date that was *met* from one that
   * was missed. Most projects have none, and nothing changes for those.
   */
  opportunities: {
    id: string;
    submissionStatus: string;
    submittedAt: Date | null;
    proposalDeadlineAt: Date | null;
    decisionExpectedAt: Date | null;
    decidedAt: Date | null;
  }[];
};

function withHealth<T extends HealthInput>(project: T, now: Date) {
  const overdueTasks = project.tasks.filter((t) => t.dueAt && t.dueAt < now).length;
  const overdueMilestones = project.milestones.filter(
    (m) => !m.completedAt && m.dueDate && m.dueDate < now,
  ).length;
  const completedMilestones = project.milestones.filter((m) => m.completedAt).length;

  // A target date met by a submitted proposal is history, not an obligation.
  // The same value is returned alongside the score, so what the screens say and
  // what the score counted cannot drift apart.
  const targetMet = meetsProjectTarget(project.targetDate, project.opportunities);

  return {
    ...project,
    overdueTasks,
    completedMilestones,
    targetMet,
    health: scoreProjectHealth({
      targetDate: project.targetDate,
      completedAt: project.completedAt,
      lastActivityAt: project.lastActivityAt,
      isTerminalStatus: project.status?.isTerminal ?? false,
      overdueTasks,
      openTasks: project.tasks.length,
      totalMilestones: project.milestones.length,
      completedMilestones,
      overdueMilestones,
      budgetCents: project.budgetCents,
      revenueCents: project.revenueCents,
      hasNextAction: Boolean(project.nextAction),
      targetMetBySubmission: targetMet,
    }),
  };
}

/** Everything the project command centre renders. */
export async function getProject(read: ReadScope, id: string) {
  const { workspaceIds } = read;
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext(read, async () => {
    const project = await db.project.findFirst({
      where: { id, workspaceId: { in: workspaceIds } },
      include: {
        workspace: { select: { id: true, name: true, color: true } },
        company: { select: { id: true, name: true, industry: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        status: { select: { id: true, name: true, color: true, isTerminal: true } },
        milestones: { orderBy: { order: "asc" } },
        contacts: {
          include: {
            contact: {
              select: { id: true, fullName: true, jobTitle: true, email: true, lastContactedAt: true },
            },
          },
        },
        deals: {
          select: {
            id: true, name: true, valueCents: true, expectedCloseAt: true,
            stage: { select: { name: true, color: true, kind: true } },
          },
          orderBy: { valueCents: "desc" },
        },
        opportunities: {
          select: {
            id: true, name: true, deadlineAt: true, submissionStatus: true, estimatedValueCents: true,
            submittedAt: true, proposalDeadlineAt: true, decisionExpectedAt: true, decidedAt: true,
          },
        },
        tasks: {
          select: {
            id: true, title: true, dueAt: true, priority: true, status: true, completedAt: true,
            contact: { select: { id: true, fullName: true } },
            deal: { select: { id: true, name: true } },
          },
          orderBy: [{ status: "asc" }, { dueAt: "asc" }],
        },
        notes: {
          // Archived notes are in the Trash, not on the record.
          where: { archivedAt: null },
          select: { id: true, title: true, plainText: true, createdAt: true, pinned: true },
          orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
          take: 8,
        },
        activities: {
          select: {
            id: true, type: true, title: true, body: true, direction: true, durationMin: true,
            noteId: true, note: { select: { archivedAt: true } },
            occurredAt: true,
            contact: { select: { id: true, fullName: true } },
            company: { select: { id: true, name: true } },
            deal: { select: { id: true, name: true } },
          },
          orderBy: { occurredAt: "desc" },
          take: 30,
        },
        files: {
          select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
        events: {
          select: { id: true, title: true, startAt: true, meetingUrl: true },
          orderBy: { startAt: "desc" },
          take: 8,
        },
        emails: {
          select: { id: true, subject: true, snippet: true, sentAt: true, direction: true, needsReply: true },
          orderBy: { sentAt: "desc" },
          take: 6,
        },
      },
    });

    if (!project) return null;

    const now = new Date();
    const openTasks = project.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
    const scored = withHealth({ ...project, tasks: openTasks }, now);
    const tags = await tagsForEntities("project", [id]);

    const statuses = await db.projectStatus.findMany({
      where: { workspaceId: project.workspaceId },
      orderBy: { order: "asc" },
    });

    return {
      ...project,
      health: scored.health,
      overdueTasks: scored.overdueTasks,
      // What met the target date, if anything — the detail page shows the date
      // either way, and this decides whether it still counts as owed.
      targetMet: scored.targetMet,
      openTasks,
      doneTasks: project.tasks.filter((t) => t.status === "done"),
      statuses,
      tags: tags.get(id) ?? [],
    };
  });
}
