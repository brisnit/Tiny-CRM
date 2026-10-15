import { NextResponse, type NextRequest } from "next/server";

import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";
import { providerFor } from "@/lib/integrations/providers";
import { startIncremental } from "@/lib/integrations/sync/worker";
import { dispatchSoon } from "@/lib/events";

/**
 * Starts syncing again after automatic recovery gave up.
 *
 * Recovery is bounded: after `MAX_RECOVERY_ATTEMPTS` consecutive failures the
 * scheduler stops and the connection is shown as needing attention. This is
 * the customer saying "try again" — so it clears the counter rather than
 * counting against it, which is the whole difference between a person asking
 * and a timer firing.
 *
 * What it does **not** do is relax eligibility. It goes through the same
 * `startIncremental` gate as the scheduler, so a disconnected, errored,
 * reauth-required or mock connection is refused here exactly as it is there,
 * and the generation compare-and-set still decides whether the job is queued.
 * A customer pressing a button cannot schedule work against a connection that
 * is not eligible for it.
 *
 * A POST, like resume and connect, because it queues work.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ vendor: string }> },
) {
  const { vendor } = await context.params;
  const form = await request.formData();
  const provider = providerFor(String(form.get("provider") ?? ""));
  const settings = new URL("/settings/integrations", request.nextUrl.origin);

  if (!provider || provider.vendor !== vendor) {
    settings.searchParams.set("connection", "invalid");
    return NextResponse.redirect(settings, { status: 303 });
  }

  const actor = await requireActor();
  const read = await resolveReadScope(await readScope());

  const result = await withTenantContext(
    {
      workspaceIds: read.workspaceIds,
      userId: actor.identity.id,
      restrictedWorkspaceIds: read.restrictedWorkspaceIds,
    },
    async () => {
      // Found from the session rather than from an id the browser sent, so
      // this cannot be pointed at somebody else's connection.
      const row = await db.integration.findFirst({
        where: {
          workspaceId: { in: read.workspaceIds },
          userId: actor.identity.id,
          provider: provider.id,
        },
        select: { id: true, workspaceId: true },
      });
      if (!row) return { queued: false, reason: "no such connection" };
      return startIncremental({
        integrationId: row.id,
        workspaceId: row.workspaceId,
        ownerUserId: actor.identity.id,
        manual: true,
      });
    },
  );

  log.info("sync retry requested", {
    provider: provider.id,
    queued: result.queued,
    reason: result.reason,
  });

  if (result.queued) {
    // Queueing is not running. Same reason as the callback and resume routes.
    dispatchSoon();
    settings.searchParams.set("connection", "retrying");
  } else {
    settings.searchParams.set("connection", "retry-refused");
  }
  return NextResponse.redirect(settings, { status: 303 });
}
