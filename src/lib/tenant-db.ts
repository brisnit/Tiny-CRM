import "server-only";

import { rootDb, runWithTenantClient, currentTenantClient } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { isPostgres } from "@/lib/env";
import { log } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Database-enforced tenant context.
 *
 * PostgreSQL row-level security (prisma/postgres/002_row_level_security.sql)
 * gates every workspace-owned table on two transaction-local settings:
 *
 *   app.workspace_ids   comma-separated workspaces this transaction may see
 *   app.user_id         the acting user, for tables scoped to a person
 *
 * This module is the only place those are set. It exists so the second layer of
 * isolation has a single, reviewable entry point, the way `access.ts` is the
 * single entry point for the first.
 *
 * ---------------------------------------------------------------------------
 * Why SET LOCAL, and why a transaction
 * ---------------------------------------------------------------------------
 *
 * A pooled connection is reused across requests. A session-scoped `SET` would
 * leave one tenant's context on the connection for whoever gets it next — a
 * cross-tenant leak created by the very mechanism meant to prevent one.
 * `SET LOCAL` is discarded at COMMIT or ROLLBACK, so context cannot outlive the
 * transaction that established it. Every call here therefore opens one.
 *
 * ---------------------------------------------------------------------------
 * What this does and does not protect
 * ---------------------------------------------------------------------------
 *
 * RLS binds a role that is neither the table owner nor a superuser.
 * **A superuser bypasses row-level security even on a table marked FORCE ROW
 * LEVEL SECURITY** — so this is only a control when `DATABASE_URL` names the
 * restricted `tinycrm_app` role. `assertRlsActive()` below checks that at
 * startup rather than assuming it, because a deployment that connects as the
 * owner gets no second layer and no error.
 *
 * On SQLite there is no equivalent, so these helpers pass through. Application
 * -level isolation is unchanged and remains the primary control on both.
 */

export type TenantContext = {
  /** Workspaces this unit of work may touch. Empty means: see nothing. */
  workspaceIds: string[];
  /** The acting user, for person-scoped tables. */
  userId?: string | null;
};

/**
 * Runs a unit of work with database-enforced tenant context.
 *
 * Anything the callback does through `tx` is filtered by RLS in addition to
 * whatever filters the query itself carries. A query that forgets its
 * `workspaceId` clause returns rows from these workspaces and no others; a
 * query run with no context at all returns nothing.
 */
export async function withTenantContext<T>(
  context: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {},
): Promise<T> {
  // Ids come from the caller's own memberships, never from a request. Rejecting
  // anything unexpected keeps the value that reaches `set_config` free of the
  // comma the setting is split on.
  const ids = context.workspaceIds.filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));
  if (ids.length !== context.workspaceIds.length) {
    throw new AppError("internal", "Something went wrong. Please try again.", {
      internal: "withTenantContext received a malformed workspace id",
    });
  }

  // Already inside a tenant transaction: reuse it rather than opening a nested
  // one, which Prisma forbids. Narrowing is not attempted — the outer context
  // was established from the same actor's memberships, and re-issuing SET LOCAL
  // would silently widen or narrow the surrounding unit of work.
  const existing = currentTenantClient();
  if (existing) return fn(existing);

  // rootDb, not db: `db` resolves to the ambient transaction, and this is the
  // call that creates one.
  return rootDb.$transaction(
    async (tx) => {
      if (isPostgres) {
        // `set_config(name, value, true)` is SET LOCAL, as a function, so the
        // value can be a bound parameter instead of interpolated SQL.
        await tx.$executeRaw`SELECT set_config('app.workspace_ids', ${ids.join(",")}, true)`;
        await tx.$executeRaw`SELECT set_config('app.user_id', ${context.userId ?? ""}, true)`;
      }
      // Bind the transaction as the ambient client so every `db.<model>` call
      // inside `fn` — including in code that never heard of tenant context —
      // runs on this transaction, and therefore under this RLS context.
      return runWithTenantClient(tx, () => fn(tx));
    },
    { timeout: options.timeout ?? 15_000 },
  );
}

/**
 * Runs a unit of work with **no** tenant context, deliberately.
 *
 * For the paths that legitimately precede any workspace: authenticating a user,
 * looking up a password-reset token, claiming a webhook delivery. Under RLS
 * these see only the tables left outside it (`User`, `AuthToken`,
 * `IdempotencyKey`, `UsageCounter`) — which is exactly the set they need.
 *
 * Named rather than implicit so a reviewer can grep for every place that runs
 * without a tenant, and so "no context" is a decision on the record rather than
 * an omission.
 */
export async function withoutTenantContext<T>(
  reason: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  log.debug("running without tenant context", { reason });
  const existing = currentTenantClient();
  if (existing) return fn(existing);
  return rootDb.$transaction(async (tx) => runWithTenantClient(tx, () => fn(tx)));
}

/**
 * Reports whether RLS is actually in force for this connection.
 *
 * Answers the question that matters — "would a query that forgot its filter be
 * stopped?" — by asking the database rather than by inspecting configuration.
 * Three things must all be true: the engine is PostgreSQL, the connection is not
 * a superuser, and the policies exist.
 */
export async function rlsStatus(): Promise<{
  active: boolean;
  engine: "postgresql" | "sqlite";
  role: string | null;
  isSuperuser: boolean;
  isTableOwner: boolean;
  protectedTables: number;
  reason: string;
}> {
  if (!isPostgres) {
    return {
      active: false,
      engine: "sqlite",
      role: null,
      isSuperuser: false,
      isTableOwner: false,
      protectedTables: 0,
      reason: "SQLite has no row-level security. Application-level isolation is the only layer.",
    };
  }

  const [identity] = await rootDb.$queryRaw<
    { role: string; is_superuser: boolean; owns_tables: boolean }[]
  >`
    SELECT
      current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
      EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) = current_user
      ) AS owns_tables
  `;

  const [counts] = await rootDb.$queryRaw<{ forced: bigint }[]>`
    SELECT count(*) AS forced
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relkind = 'r'
      AND relrowsecurity
      AND relforcerowsecurity
  `;

  const protectedTables = Number(counts?.forced ?? 0);
  const isSuperuser = Boolean(identity?.is_superuser);
  const isTableOwner = Boolean(identity?.owns_tables);

  let reason: string;
  let active: boolean;

  if (protectedTables === 0) {
    active = false;
    reason = "No table has FORCE ROW LEVEL SECURITY. Apply prisma/postgres/002_row_level_security.sql.";
  } else if (isSuperuser) {
    active = false;
    reason =
      `Connected as "${identity!.role}", which is a superuser. ` +
      "A superuser bypasses row-level security even on a FORCE'd table. " +
      "Point DATABASE_URL at the restricted tinycrm_app role.";
  } else {
    // FORCE binds the owner too, so owning tables does not disable RLS — but it
    // does mean the role can alter the policies, which is worth flagging.
    active = true;
    reason = isTableOwner
      ? `Active for "${identity!.role}" across ${protectedTables} tables, but this role owns the tables and can alter its own policies.`
      : `Active for "${identity!.role}" across ${protectedTables} tables.`;
  }

  return {
    active,
    engine: "postgresql",
    role: identity?.role ?? null,
    isSuperuser,
    isTableOwner,
    protectedTables,
    reason,
  };
}

/**
 * Startup assertion for a production deployment.
 *
 * Called from `src/instrumentation.ts`. It warns rather than throws, because a
 * missing second layer must not take down a deployment whose first layer is
 * intact — but it says so at error level, every boot, until it is fixed.
 */
export async function reportRlsStatus(): Promise<void> {
  try {
    const status = await rlsStatus();
    if (status.active) {
      log.info("row-level security active", {
        role: status.role,
        tables: status.protectedTables,
      });
    } else {
      log.error("row-level security is NOT protecting this connection", {
        reason: status.reason,
      });
    }
  } catch (error) {
    log.error("could not determine row-level security status", { error: String(error) });
  }
}
