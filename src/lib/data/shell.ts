import "server-only";

import { db } from "@/lib/db";
import { getUserWorkspaces, type SessionUser } from "@/lib/auth/session";
import { describeProvider, isModelBacked } from "@/lib/ai/provider";
import { colorForKey } from "@/lib/utils";
import type { ShellData } from "@/components/app/shell";

/**
 * Everything the persistent chrome needs, in one pass. Kept in a single query
 * batch so the shell adds a fixed, small cost to every page render rather than
 * a cascade of round-trips.
 */
export async function getShellData(
  user: SessionUser,
  scope: string,
  workspaceIds: string[],
  projectFocus: string | null,
): Promise<ShellData> {
  const workspaces = await getUserWorkspaces(user.id);
  const where = { workspaceId: { in: workspaceIds } };
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const [overdue, tasksToday, projects, notifications, unreadCount, pipelines, statuses] =
    await Promise.all([
      db.task.count({
        where: { ...where, status: { in: ["open", "in_progress"] }, dueAt: { lt: now } },
      }),
      db.task.count({
        where: {
          ...where,
          status: { in: ["open", "in_progress"] },
          dueAt: { gte: now, lte: endOfToday },
        },
      }),
      db.project.findMany({
        where: { ...where, archivedAt: null, status: { isTerminal: false } },
        select: {
          id: true, name: true, workspaceId: true,
          status: { select: { color: true } },
        },
        orderBy: { lastActivityAt: "desc" },
        take: 40,
      }),
      db.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true, type: true, title: true, body: true, createdAt: true, readAt: true,
          entityType: true, entityId: true,
          workspace: { select: { name: true } },
        },
      }),
      db.notification.count({ where: { userId: user.id, readAt: null } }),
      db.pipeline.findMany({
        where: { ...where, kind: "deal" },
        select: {
          id: true, name: true, workspaceId: true,
          stages: { select: { id: true, name: true }, orderBy: { order: "asc" } },
        },
        orderBy: { order: "asc" },
      }),
      db.projectStatus.findMany({
        where,
        select: { id: true, name: true, workspaceId: true },
        orderBy: { order: "asc" },
      }),
    ]);

  const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));
  const provider = describeProvider();

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      plan: user.plan,
    },
    workspaces,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.status?.color ?? colorForKey(p.name),
      workspaceName: workspaceNames.get(p.workspaceId) ?? "",
    })),
    scope,
    projectFocus,
    counts: { overdue, tasksToday },
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
      workspaceName: n.workspace?.name ?? null,
      href: hrefFor(n.entityType, n.entityId),
    })),
    unreadCount,
    quickAdd: {
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
      defaultWorkspaceId: scope !== "all" ? scope : (workspaces[0]?.id ?? null),
      pipelines,
      statuses,
    },
    ai: { providerLabel: provider.label, modelBacked: isModelBacked() },
  };
}

function hrefFor(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const map: Record<string, string> = {
    contact: "/contacts",
    company: "/companies",
    deal: "/deals",
    project: "/projects",
    opportunity: "/opportunities",
  };
  const base = map[entityType];
  return base ? `${base}/${entityId}` : null;
}
