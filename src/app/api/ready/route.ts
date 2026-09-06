import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { isPostgres } from "@/lib/env";

/**
 * Readiness check for a load balancer or orchestrator.
 *
 * Distinct from `/api/health`: liveness asks "is the process alive", readiness
 * asks "should traffic be sent here yet". A pod that is up but cannot reach the
 * database should be pulled from rotation rather than restarted.
 */
export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({ ready: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ready: false },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
