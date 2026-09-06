import { NextResponse } from "next/server";

import { db } from "@/lib/db";

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
    // Reads a real table, so a migration that has not run yet fails readiness.
    await db.workspace.count({ take: 1 } as never).catch(() => db.$queryRaw`SELECT 1`);
    return NextResponse.json({ ready: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ready: false },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
