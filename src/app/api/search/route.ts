import { NextResponse } from "next/server";

import { getActor, resolveReadScope } from "@/lib/auth/access";
import { searchEverything } from "@/lib/data/search";
import { toAppError } from "@/lib/errors";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { clientAddress, enforceRateLimit } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/validation/limits";
import { zScope, zSearchQuery } from "@/lib/validation/common";

/**
 * Global search.
 *
 * The prototype accepted an unbounded `q` and no rate limit. Both are now
 * enforced, and the scope is resolved from the session — the `scope` parameter
 * can only ever narrow the workspaces already available to this user.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = newRequestId();

  return runWithContext({ requestId, route: "api.search" }, async () => {
    try {
      const actor = await getActor();
      if (!actor) {
        return NextResponse.json({ hits: [], requestId }, { status: 401 });
      }

      await enforceRateLimit("search", { user: actor.identity.id, ip: clientAddress(request.headers) });

      const { searchParams } = new URL(request.url);
      const rawQuery = searchParams.get("q") ?? "";

      // Too short is not an error, just no results — the UI types into this.
      if (rawQuery.trim().length < LIMITS.searchQuery.min) {
        return NextResponse.json({ hits: [], requestId });
      }

      const query = zSearchQuery.parse(rawQuery.slice(0, LIMITS.searchQuery.max));
      const scope = zScope.parse(searchParams.get("scope"));
      const { workspaceIds } = await resolveReadScope(scope);

      const hits = await searchEverything(workspaceIds, query);

      return NextResponse.json(
        { hits: hits.slice(0, 30), requestId },
        { headers: { "x-request-id": requestId, "cache-control": "no-store" } },
      );
    } catch (raw) {
      const error = toAppError(raw);
      if (error.category === "internal") {
        log.error("search failed", { error: String(error.internal) });
      }
      return NextResponse.json(
        { hits: [], error: error.message, requestId },
        { status: error.status, headers: { "x-request-id": requestId } },
      );
    }
  });
}
