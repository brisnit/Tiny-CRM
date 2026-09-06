import "server-only";

import { cache } from "react";
import { AsyncLocalStorage } from "node:async_hooks";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { isProduction, isTest } from "@/lib/env";
import { enrichContext } from "@/lib/logger";
import { unauthorized } from "@/lib/errors";
import type { Role } from "@/lib/auth/permissions";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * The authentication boundary.
 *
 * This is the ONLY module in the application that knows NextAuth exists.
 * Everything else asks for an `Identity` and a set of `WorkspaceMembership`s.
 * Swapping to Clerk, WorkOS or Auth0 means reimplementing `resolveSession()` —
 * one function, roughly ten lines — and nothing else in the CRM changes.
 */

export type Identity = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  plan: string;
  onboardedAt: Date | null;
  /// Null until the address has been confirmed. Gates the capabilities listed
  /// in src/lib/auth/verification.ts.
  emailVerifiedAt: Date | null;
  /// The session this identity was resolved from, when there is one. Null for
  /// the in-process test identity, which has no session row.
  sessionId: string | null;
};

export type WorkspaceMembership = {
  id: string;
  name: string;
  slug: string;
  color: string;
  role: Role;
};

/**
 * What an auth provider must supply. Everything else is derived from the
 * database.
 *
 * `sessionId` and `epoch` are what make a JWT revocable: the id must match a
 * live `UserSession` row, and the epoch must not be behind the user's current
 * one. Both are optional in the type because the test identity has neither.
 */
export type SessionClaims = {
  userId: string;
  sessionId?: string | null;
  epoch?: number | null;
  issuedAt?: Date | null;
};

/**
 * Test-only identity override.
 *
 * Security tests need to act as a specific user without going through a browser.
 * This lives behind AsyncLocalStorage in a `server-only` module with no
 * `"use server"` directive, so it is unreachable over HTTP by construction — an
 * attacker cannot enter this scope, only in-process test code can. It is
 * additionally refused unless NODE_ENV=test, and assertProductionEnv() rejects
 * the enabling variable outright.
 */
const testIdentity = new AsyncLocalStorage<SessionClaims>();

export function runAsTestIdentity<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (!isTest) {
    throw new Error("runAsTestIdentity() is only available when NODE_ENV=test.");
  }
  return testIdentity.run({ userId }, fn);
}

async function resolveSession(): Promise<SessionClaims | null> {
  if (isTest && !isProduction) {
    const injected = testIdentity.getStore();
    if (injected) return injected;
  }
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const claims = session as unknown as {
    sessionId?: string | null;
    epoch?: number | null;
    issuedAt?: number | null;
  };

  return {
    userId,
    sessionId: claims.sessionId ?? null,
    epoch: claims.epoch ?? null,
    issuedAt: claims.issuedAt ? new Date(claims.issuedAt * 1000) : null,
  };
}

/**
 * `cache()` dedupes across one render pass, so a page, its layout and every
 * server action in the same request share a single lookup.
 */
export const getIdentity = cache(async (): Promise<Identity | null> => {
  const claims = await resolveSession();
  if (!claims) return null;

  const user = await db.user.findUnique({
    where: { id: claims.userId },
    select: {
      id: true, email: true, name: true, avatarUrl: true, plan: true, onboardedAt: true,
      deactivatedAt: true, emailVerifiedAt: true,
    },
  });
  // A deactivated account must lose access immediately, even while holding a
  // structurally valid JWT — this is why the session is re-checked against the
  // database rather than trusted from the token alone.
  if (!user || user.deactivatedAt) return null;

  // The session must still be live. A JWT is self-contained and would otherwise
  // remain usable for its full lifetime after a sign-out, a password change or a
  // "sign out everywhere" — which is exactly what the previous hardening report
  // flagged. The in-process test identity carries no session and skips this.
  let sessionId: string | null = null;
  if (!(isTest && testIdentity.getStore())) {
    const { validateSession, touchSession } = await import("@/lib/auth/sessions");
    const check = await validateSession(user.id, claims.sessionId, claims.epoch, claims.issuedAt);
    if (!check.valid) {
      enrichContext({ userId: user.id });
      return null;
    }
    sessionId = check.sessionId;
    void touchSession(check.sessionId);
  }

  enrichContext({ userId: user.id });
  return {
    id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl,
    plan: user.plan, onboardedAt: user.onboardedAt,
    emailVerifiedAt: user.emailVerifiedAt, sessionId,
  };
});

export async function requireIdentity(): Promise<Identity> {
  const identity = await getIdentity();
  if (!identity) throw unauthorized();
  return identity;
}

/**
 * Every workspace the user is a member of, with their role. This is the root of
 * all tenant isolation: no code path may widen access beyond this list.
 */
export const getMemberships = cache(async (userId: string): Promise<WorkspaceMembership[]> => {
  // This is the lookup that produces the tenant context, so it cannot run
  // inside one. It runs with the user in context and no workspaces, which is
  // exactly what prisma/postgres/005_identity_policies.sql permits: a user may
  // always read their own membership rows and the workspaces those rows name.
  // Nothing else is visible from here.
  const rows = await withTenantContext({ workspaceIds: [], userId }, async () =>
    db.workspaceMember.findMany({
      where: { userId, workspace: { archivedAt: null } },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, slug: true, color: true, createdAt: true } },
      },
        orderBy: { workspace: { createdAt: "asc" } },
    }),
  );

  return rows.map((row) => ({
    id: row.workspace.id,
    name: row.workspace.name,
    slug: row.workspace.slug,
    color: row.workspace.color,
    role: row.role as Role,
  }));
});
