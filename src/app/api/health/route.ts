import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Liveness and dependency check.
 *
 * Deliberately minimal. It reports whether the process is up and whether the
 * database answers — nothing about versions of dependencies, connection
 * strings, hostnames or configuration, because this endpoint is unauthenticated
 * and reconnaissance is cheap.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  let database: "ok" | "unavailable" = "ok";

  try {
    // Cheapest possible round-trip that proves the connection works.
    await db.$queryRaw`SELECT 1`;
  } catch {
    database = "unavailable";
  }

  const healthy = database === "ok";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      // A build identifier, not a dependency inventory.
      release: env.release,
      database,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
