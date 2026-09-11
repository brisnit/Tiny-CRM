import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { isPostgres } from "@/lib/env";
import { log } from "@/lib/logger";
import { schemaState } from "@/lib/db/schema-state";

/**
 * Readiness check for a load balancer or orchestrator.
 *
 * Distinct from `/api/health`: liveness asks "is the process alive", readiness
 * asks "should traffic be sent here yet". A pod that is up but cannot reach the
 * database should be pulled from rotation rather than restarted.
 *
 * It also asks whether the database is as far along as this build. That was
 * added after a deploy shipped ahead of its migration: the process was alive,
 * `SELECT 1` succeeded, `Workspace` existed, this endpoint said ready — and two
 * pages threw on every request because they selected a column that had not been
 * created yet. Both of the old checks were structurally incapable of seeing it.
 *
 * The public body stays deliberately thin. A readiness probe is unauthenticated,
 * so it says *that* the schema is behind and by how many, and nothing about
 * which migrations, what they contain, or what the database is. The names go to
 * the server log, where the person fixing it can see them.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const notReady = (body: Record<string, unknown>) =>
    NextResponse.json({ ready: false, ...body }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });

  try {
    // Proves the schema is present without reading tenant data. Counting a
    // workspace-scoped table would return 0 under RLS whether or not the table
    // exists, so it proved nothing here and needed a tenant context it has no
    // business holding. to_regclass answers "has the migration run?" directly.
    const rows = isPostgres
      ? await db.$queryRaw<{ n: bigint | number }[]>`
          SELECT count(*) AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'Workspace'
        `
      : await db.$queryRaw<{ n: bigint | number }[]>`
          SELECT count(*) AS n FROM sqlite_master
          WHERE type = 'table' AND name = 'Workspace'
        `;
    if (Number(rows[0]?.n ?? 0) === 0) throw new Error("schema is not present");
  } catch {
    return notReady({});
  }

  // Reachable and populated, but possibly older than this build expects.
  const state = await schemaState();

  if (state.status === "behind") {
    log.error("database schema is behind the deployed code", {
      pending: state.pending,
      // Server-side only. The response carries the count and nothing else.
      migrations: state.pendingNames.join(","),
    });
    return notReady({ reason: "schema_behind", pending: state.pending });
  }

  if (state.status === "unknown") {
    // The check itself failed. That is not proof of drift, but it is not proof
    // of readiness either, and readiness must fail closed.
    log.error("could not determine migration state", { reason: state.reason });
    return notReady({ reason: "schema_unknown" });
  }

  return NextResponse.json({ ready: true }, { headers: { "cache-control": "no-store" } });
}
