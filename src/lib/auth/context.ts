import "server-only";

import { cache } from "react";
import { AsyncLocalStorage } from "node:async_hooks";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { isProduction, isTest } from "@/lib/env";
import { enrichContext } from "@/lib/logger";
import { unauthorized } from "@/lib/errors";
import type { Role } from "@/lib/auth/permissions";

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
};

export type WorkspaceMembership = {
  id: string;
  name: string;
  slug: string;
  color: string;
  role: Role;
};

/** What an auth provider must supply. Everything else is derived from the database. */
export type SessionClaims = { userId: string };

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
  return userId ? { userId } : null;
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
      deactivatedAt: true,
    },
  });
  // A deactivated account must lose access immediately, even while holding a
  // structurally valid JWT — this is why the session is re-checked against the
  // database rather than trusted from the token alone.
  if (!user || user.deactivatedAt) return null;

  enrichContext({ userId: user.id });
  const { deactivatedAt: _deactivatedAt, ...identity } = user;
  return identity;
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
  const rows = await db.workspaceMember.findMany({
    where: { userId, workspace: { archivedAt: null } },
    select: {
      role: true,
      workspace: { select: { id: true, name: true, slug: true, color: true, createdAt: true } },
    },
    orderBy: { workspace: { createdAt: "asc" } },
  });

  return rows.map((row) => ({
    id: row.workspace.id,
    name: row.workspace.name,
    slug: row.workspace.slug,
    color: row.workspace.color,
    role: row.role as Role,
  }));
});
