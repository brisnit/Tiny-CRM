import { NextResponse, type NextRequest } from "next/server";

import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";
import { providerFor } from "@/lib/integrations/providers";
import { resumeBackfill } from "@/lib/integrations/sync/worker";
import { dispatchSoon } from "@/lib/events";

/**
 * Continues an import the page cap stopped.
 *
 * A POST, like starting a connection, because it queues work. It gives the
 * resumed attempt a fresh page budget: the cap exists to bound one unattended
 * run, not to refuse somebody who has read the incomplete state and asked for
 * the rest.
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

  const resumed = await withTenantContext(
    {
      workspaceIds: read.workspaceIds,
      userId: actor.identity.id,
      restrictedWorkspaceIds: read.restrictedWorkspaceIds,
    },
    async () => {
      // Found from the session rather than from an id the browser sent.
      const row = await db.integration.findFirst({
        where: {
          workspaceId: { in: read.workspaceIds },
          userId: actor.identity.id,
          provider: provider.id,
        },
        select: { id: true, workspaceId: true },
      });
      if (!row) return { resumed: false };
      return resumeBackfill({
        integrationId: row.id,
        workspaceId: row.workspaceId,
        ownerUserId: actor.identity.id,
      });
    },
  );

  log.info("import resume requested", { provider: provider.id, resumed: resumed.resumed });

  // Same reason as the callback route: `resumeBackfill` queues a page, and a
  // queued page that nothing drains is not a resumed import. Without this,
  // pressing Resume changed the Settings text and waited for the cron.
  if (resumed.resumed) dispatchSoon();

  settings.searchParams.set("connection", resumed.resumed ? "resuming" : "nothing-to-resume");
  return NextResponse.redirect(settings, { status: 303 });
}
