import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { ROLE_RANK } from "@/lib/enums";
import { PlanLimitError, UNLIMITED, type LimitKey, limitFor } from "@/lib/plans";
import { currentPeriod } from "@/lib/dates";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  plan: string;
  onboardedAt: Date | null;
};

/**
 * `cache()` dedupes this across a single render pass, so a page, its layout and
 * every server action in the same request share one query instead of ten.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      plan: true,
      onboardedAt: true,
    },
  });
  return user ?? null;
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

// ---------------------------------------------------------------------------
// Workspace access
// ---------------------------------------------------------------------------

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  color: string;
  role: string;
};

/**
 * Every workspace the user can see, ordered for the switcher. This is the only
 * place workspace visibility is decided; data queries take the resulting ids.
 */
export const getUserWorkspaces = cache(async (userId: string): Promise<WorkspaceSummary[]> => {
  const memberships = await db.workspaceMember.findMany({
    where: { userId, workspace: { archivedAt: null } },
    select: {
      role: true,
      workspace: { select: { id: true, name: true, slug: true, color: true, createdAt: true } },
    },
    orderBy: { workspace: { createdAt: "asc" } },
  });

  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    color: m.workspace.color,
    role: m.role,
  }));
});

export class AccessError extends Error {
  constructor(message = "You do not have access to this record.") {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * Resolves the workspace ids a query is allowed to touch.
 *
 * `scope` is either a single workspace id or "all" (the All Businesses view).
 * Passing the result as a `workspaceId: { in: [...] }` filter is what keeps
 * tenancy enforced at the database rather than in the UI.
 */
export async function resolveScope(
  userId: string,
  scope: string | null | undefined,
): Promise<{ workspaceIds: string[]; workspaceId: string | null; isAll: boolean }> {
  const workspaces = await getUserWorkspaces(userId);
  const ids = workspaces.map((w) => w.id);

  if (!scope || scope === "all") {
    return { workspaceIds: ids, workspaceId: null, isAll: true };
  }
  if (!ids.includes(scope)) {
    // Silently fall back rather than erroring: a stale cookie pointing at a
    // deleted workspace should not lock the user out of their own app.
    return { workspaceIds: ids, workspaceId: null, isAll: true };
  }
  return { workspaceIds: [scope], workspaceId: scope, isAll: false };
}

/** Throws unless the user holds at least `minimum` role in the workspace. */
export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  minimum: "viewer" | "member" | "manager" | "admin" | "owner" = "member",
) {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) throw new AccessError();
  if ((ROLE_RANK[membership.role] ?? -1) < (ROLE_RANK[minimum] ?? 0)) {
    throw new AccessError("Your role does not allow that.");
  }
  return membership.role;
}

/** Asserts the workspace belongs to the user, returning it for writes. */
export async function requireWorkspace(
  userId: string,
  workspaceId: string,
  minimum: "viewer" | "member" | "manager" | "admin" | "owner" = "member",
) {
  await requireWorkspaceRole(userId, workspaceId, minimum);
  return workspaceId;
}

// ---------------------------------------------------------------------------
// Plan limits
// ---------------------------------------------------------------------------

const LIMIT_MODEL: Record<
  Exclude<LimitKey, "seats" | "aiRequestsPerMonth" | "workspaces">,
  "contact" | "company" | "deal" | "project" | "opportunity" | "task" | "automation" | "savedView" | "customFieldDef"
> = {
  contacts: "contact",
  companies: "company",
  deals: "deal",
  projects: "project",
  opportunities: "opportunity",
  tasks: "task",
  automations: "automation",
  savedViews: "savedView",
  customFields: "customFieldDef",
};

/**
 * Counts what the user already has across *all* their workspaces and throws if
 * creating one more would exceed their plan. Enforced here, in the server
 * action path, so the limit cannot be bypassed by calling the API directly.
 */
export async function assertWithinLimit(
  user: SessionUser,
  key: LimitKey,
  additional = 1,
): Promise<void> {
  const limit = limitFor(user.plan, key);
  if (limit === UNLIMITED) return;

  const workspaces = await getUserWorkspaces(user.id);
  const workspaceIds = workspaces.map((w) => w.id);

  let used = 0;
  if (key === "workspaces") {
    used = workspaces.length;
  } else if (key === "aiRequestsPerMonth") {
    const counter = await db.usageCounter.findUnique({
      where: { userId_metric_period: { userId: user.id, metric: "ai_requests", period: currentPeriod() } },
      select: { count: true },
    });
    used = counter?.count ?? 0;
  } else if (key === "seats") {
    used = 1;
  } else {
    const model = LIMIT_MODEL[key as keyof typeof LIMIT_MODEL];
    if (!model) return;
    if (model === "savedView") {
      used = await db.savedView.count({ where: { userId: user.id } });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      used = await (db as any)[model].count({ where: { workspaceId: { in: workspaceIds } } });
    }
  }

  if (used + additional > limit) {
    throw new PlanLimitError(key, limit, (user.plan as "free" | "pro" | "lifetime") ?? "free");
  }
}

/** Current usage across every limited resource — powers Settings → Billing. */
export async function getPlanUsage(user: SessionUser) {
  const workspaces = await getUserWorkspaces(user.id);
  const workspaceIds = workspaces.map((w) => w.id);
  const where = { workspaceId: { in: workspaceIds } };

  const [contacts, companies, deals, projects, opportunities, tasks, automations, savedViews, customFields, ai] =
    await Promise.all([
      db.contact.count({ where }),
      db.company.count({ where }),
      db.deal.count({ where }),
      db.project.count({ where }),
      db.opportunity.count({ where }),
      db.task.count({ where }),
      db.automation.count({ where }),
      db.savedView.count({ where: { userId: user.id } }),
      db.customFieldDef.count({ where }),
      db.usageCounter.findUnique({
        where: { userId_metric_period: { userId: user.id, metric: "ai_requests", period: currentPeriod() } },
        select: { count: true },
      }),
    ]);

  return {
    workspaces: workspaces.length,
    contacts,
    companies,
    deals,
    projects,
    opportunities,
    tasks,
    automations,
    savedViews,
    customFields,
    aiRequestsPerMonth: ai?.count ?? 0,
    seats: 1,
  } satisfies Record<LimitKey, number>;
}

export async function recordUsage(userId: string, metric: string, amount = 1) {
  const period = currentPeriod();
  await db.usageCounter.upsert({
    where: { userId_metric_period: { userId, metric, period } },
    create: { userId, metric, period, count: amount },
    update: { count: { increment: amount } },
  });
}
