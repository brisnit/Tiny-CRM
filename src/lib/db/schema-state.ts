import "server-only";

import { rootDb } from "@/lib/db";
import { isPostgres } from "@/lib/env";
import { POSTGRES_MIGRATIONS, SQLITE_MIGRATIONS } from "@/lib/db/migration-manifest";

/**
 * Is the database as far along as the code that is talking to it?
 *
 * The incident this comes from: a schema change deployed while its migration
 * was still unapplied. The application started fine, `SELECT 1` succeeded, the
 * readiness probe reported green — and two pages threw on every request,
 * because they selected a column that did not exist yet. Liveness and a
 * table-exists check are both structurally blind to that: the database is
 * reachable and the old tables are all still there.
 *
 * So readiness asks the question that was actually unanswered — has everything
 * this build expects been applied? — by comparing the manifest baked into the
 * bundle against `_prisma_migrations`.
 *
 * Two deliberate choices:
 *
 *  - **Names, not a count.** A count matches by coincidence when one migration
 *    is applied and a different one is not, which is exactly the shape of a
 *    hand-applied history that went wrong.
 *  - **Only "behind" is unready.** A database *ahead* of the code — mid-rollout,
 *    or a rollback — is not a reason to refuse traffic; the old code runs fine
 *    against a newer schema, and pulling those instances out of rotation during
 *    a deploy would turn a normal window into an outage.
 */

export type SchemaState =
  | { status: "current" }
  | { status: "behind"; pending: number; pendingNames: string[] }
  | { status: "unknown"; reason: string };

/** The migrations this build expects, for the engine it is configured against. */
export function expectedMigrations(): readonly string[] {
  return isPostgres ? POSTGRES_MIGRATIONS : SQLITE_MIGRATIONS;
}

/**
 * Compares the manifest against `_prisma_migrations`.
 *
 * `rootDb`, not `db`: this runs outside any tenant context and reads Prisma's
 * own bookkeeping table, which carries no workspace column and is not under
 * RLS. Going through the tenant proxy would attach it to whatever transaction
 * happened to be ambient.
 *
 * One indexed read of a table that holds one row per migration — cheap enough
 * for a probe that a load balancer hits every few seconds.
 */
export async function schemaState(): Promise<SchemaState> {
  const expected = expectedMigrations();
  if (expected.length === 0) return { status: "unknown", reason: "manifest_empty" };

  let applied: Set<string>;
  try {
    // Unfinished rows are deliberately not counted as applied: a migration that
    // failed halfway leaves a row with a null finished_at, and treating that as
    // done is how a half-migrated database reports healthy.
    const rows = await rootDb.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    applied = new Set(rows.map((r) => r.migration_name));
  } catch (error) {
    // The table is missing, unreachable, or the query failed. Any of those
    // means the state is unknown, and unknown must not read as ready.
    return {
      status: "unknown",
      reason: error instanceof Error ? error.name : "query_failed",
    };
  }

  const pendingNames = expected.filter((name) => !applied.has(name));
  if (pendingNames.length > 0) {
    return { status: "behind", pending: pendingNames.length, pendingNames };
  }
  return { status: "current" };
}
