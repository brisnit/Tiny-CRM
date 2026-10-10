import "server-only";

import { db } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/admin/authorize";
import { activeGrantWhere, effectiveFrom, GRANT_SELECT } from "@/lib/plan-grants";
import { isPostgres } from "@/lib/env";

/**
 * Reads for the admin panel.
 *
 * Separate from `src/lib/actions/admin.ts` because that module carries the
 * `"use server"` directive: every one of its exports becomes a POST endpoint,
 * so a read helper living there would be a reachable endpoint that happens to
 * return data, and a non-async export there is a build-time error. Reads here,
 * mutations there.
 *
 * Every function still calls `requirePlatformAdmin()` itself. Being on the
 * read side is not a reason to check less.
 */

export type CustomerRow = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  /** The raw column — what Stripe charges for. */
  storedPlan: string;
  /** What the account can actually do. */
  effectivePlan: string;
  /** The complimentary grant in force, if any. */
  grant: { plan: string; reason: string; expiresAt: Date | null } | null;
  planStatus: string;
  billingCustomerId: string | null;
  suspended: boolean;
  workspacesOwned: number;
  memberships: number;
};

/**
 * The customer directory.
 *
 * `User` is outside row-level security, so this needs no special policy — it is
 * the membership counts below that do. Searching is a case-insensitive contains
 * on name or email; Postgres gets `mode: "insensitive"` and SQLite is already
 * case-insensitive for ASCII `LIKE`, so the same query serves both.
 */
export async function listCustomers(options: {
  query?: string;
  page?: number;
  perPage?: number;
}): Promise<{ rows: CustomerRow[]; total: number; page: number; perPage: number }> {
  await requirePlatformAdmin();

  const perPage = Math.min(Math.max(options.perPage ?? 25, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const query = (options.query ?? "").trim();

  const where = query
    ? {
        OR: [
          { email: { contains: query, ...(isPostgres ? { mode: "insensitive" as const } : {}) } },
          { name: { contains: query, ...(isPostgres ? { mode: "insensitive" as const } : {}) } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true, email: true, name: true, createdAt: true,
        plan: true, planStatus: true, billingCustomerId: true, deactivatedAt: true,
        planGrants: { where: activeGrantWhere(), select: GRANT_SELECT },
        _count: { select: { ownedWorkspaces: true, memberships: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    perPage,
    rows: users.map((u) => {
      const entitlement = effectiveFrom(u.plan, u.planGrants);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        storedPlan: entitlement.stored,
        effectivePlan: entitlement.effective,
        grant: entitlement.grant
          ? {
              plan: entitlement.grant.plan,
              reason: entitlement.grant.reason,
              expiresAt: entitlement.grant.expiresAt,
            }
          : null,
        planStatus: u.planStatus,
        billingCustomerId: u.billingCustomerId,
        suspended: Boolean(u.deactivatedAt),
        workspacesOwned: u._count.ownedWorkspaces,
        memberships: u._count.memberships,
      };
    }),
  };
}

/** The effective entitlement for one account, as the admin panel shows it. */
export async function entitlementForAdmin(userId: string) {
  await requirePlatformAdmin();
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, planGrants: { where: activeGrantWhere(), select: GRANT_SELECT } },
  });
  return effectiveFrom(user.plan, user.planGrants);
}

export type CustomerDetail = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  emailVerifiedAt: Date | null;
  suspended: boolean;
  suspendedReason: string | null;
  /** What Stripe charges for, and what it says about it. */
  billing: {
    storedPlan: string;
    planStatus: string;
    renewsAt: Date | null;
    customerId: string | null;
  };
  /** What the account can actually do, and why. */
  entitlement: {
    underlying: string;
    effective: string;
    grant: { id: string; plan: string; reason: string; expiresAt: Date | null } | null;
  };
  /** Workspaces this account **owns** — whose plan is therefore theirs. */
  owned: { id: string; name: string; members: number }[];
  /**
   * Workspaces this account merely belongs to. Listed separately and
   * deliberately: an invited member's personal plan does not decide the
   * workspace's entitlement, the *owner's* does, so showing these together
   * would invite exactly the wrong conclusion.
   */
  memberOf: { id: string; name: string; role: string; ownerEmail: string; ownerPlan: string }[];
  grants: {
    id: string; plan: string; reason: string; expiresAt: Date | null;
    grantedAt: Date; revokedAt: Date | null; revokedReason: string | null;
  }[];
};

/** Everything the detail page shows about one account. */
export async function customerDetail(userId: string): Promise<CustomerDetail | null> {
  await requirePlatformAdmin();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, createdAt: true, lastSeenAt: true,
      emailVerifiedAt: true, deactivatedAt: true, deactivatedReason: true,
      plan: true, planStatus: true, planRenewsAt: true, billingCustomerId: true,
      planGrants: {
        orderBy: { grantedAt: "desc" },
        take: 25,
        select: {
          id: true, plan: true, reason: true, expiresAt: true,
          grantedAt: true, revokedAt: true, revokedReason: true,
        },
      },
      ownedWorkspaces: {
        select: { id: true, name: true, _count: { select: { members: true } } },
        orderBy: { name: "asc" },
      },
      memberships: {
        select: {
          role: true,
          workspace: {
            select: { id: true, name: true, owner: { select: { email: true, plan: true } } },
          },
        },
      },
    },
  });
  if (!user) return null;

  const live = user.planGrants.filter(
    (g) => !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > Date.now()),
  );
  const entitlement = effectiveFrom(user.plan, live);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    emailVerifiedAt: user.emailVerifiedAt,
    suspended: Boolean(user.deactivatedAt),
    suspendedReason: user.deactivatedReason,
    billing: {
      storedPlan: user.plan,
      planStatus: user.planStatus,
      renewsAt: user.planRenewsAt,
      customerId: user.billingCustomerId,
    },
    entitlement: {
      underlying: entitlement.underlying,
      effective: entitlement.effective,
      grant: entitlement.grant
        ? {
            id: entitlement.grant.id,
            plan: entitlement.grant.plan,
            reason: entitlement.grant.reason,
            expiresAt: entitlement.grant.expiresAt,
          }
        : null,
    },
    // Owned workspaces come back only because the admin's RLS policy permits
    // it; for any other caller this list is empty, which is the isolation
    // test's subject.
    owned: user.ownedWorkspaces.map((w) => ({ id: w.id, name: w.name, members: w._count.members })),
    memberOf: user.memberships
      .filter((m) => m.workspace.owner.email !== user.email)
      .map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        role: m.role,
        ownerEmail: m.workspace.owner.email,
        ownerPlan: m.workspace.owner.plan,
      })),
    grants: user.planGrants,
  };
}

/**
 * The administrative trail, as the admin can actually read it.
 *
 * Deliberately not a privileged read: this goes through the ordinary client,
 * so what comes back is what RLS permits. If the policy ever stopped admitting
 * these rows, this page would go empty rather than quietly keep working on a
 * back channel — which is the failure mode worth having.
 */
export async function administrativeAudit(limit = 50) {
  const admin = await requirePlatformAdmin();
  return db.auditLog.findMany({
    where: { actorId: admin.identity.id, action: { startsWith: "admin." } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, action: true, summary: true, entityId: true,
      metadata: true, createdAt: true, actorEmail: true,
    },
  });
}
