"use server";

import { z } from "zod";

import { audit, guard, revalidatePathSafely, type ActionResult } from "@/lib/actions/base";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { disconnectConnection } from "@/lib/integrations/connections";
import { providerFor } from "@/lib/integrations/providers";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Disconnecting, as a server action.
 *
 * Connecting is a route rather than an action — see
 * src/app/api/integrations/[vendor]/start/route.ts for why. Disconnecting has
 * no redirect to a third party and no cookie to set, so it is an ordinary
 * action with an ordinary confirmation.
 *
 * `keepImported` is the customer's explicit choice, passed through rather than
 * defaulted here, because the default belongs in the dialog where they can see
 * what it means.
 */
const schema = z.object({
  provider: z.string().min(1),
  keepImported: z.boolean(),
});

export async function disconnectIntegration(
  input: z.infer<typeof schema>,
): Promise<ActionResult<{ removedEmails: number; removedEvents: number }>> {
  return guard(async () => {
    const parsed = schema.parse(input);
    const provider = providerFor(parsed.provider);
    if (!provider) throw new AppError("validation", "That is not a connection we support.");

    const actor = await requireActor();
    const read = await resolveReadScope(await readScope());

    return withTenantContext(
      {
        workspaceIds: read.workspaceIds,
        userId: actor.identity.id,
        restrictedWorkspaceIds: read.restrictedWorkspaceIds,
      },
      async () => {
        // Found by (workspace, user, provider) rather than by an id from the
        // browser: a connection belongs to the person who made it, and an id
        // a client supplied must not be what decides which one is destroyed.
        const row = await db.integration.findFirst({
          where: {
            workspaceId: { in: read.workspaceIds },
            userId: actor.identity.id,
            provider: provider.id,
          },
          select: { id: true, workspaceId: true },
        });
        if (!row) throw new AppError("not_found", "That connection does not exist.");

        const result = await disconnectConnection({
          integrationId: row.id,
          userId: actor.identity.id,
          keepImported: parsed.keepImported,
        });

        await audit(actor, {
          workspaceId: row.workspaceId,
          action: "integration.disconnected",
          entityType: "integration",
          entityId: row.id,
          summary: `Disconnected ${provider.label}${
            parsed.keepImported ? ", keeping imported data" : ", removing imported data"
          }`,
          metadata: {
            provider: provider.id,
            keptImported: parsed.keepImported,
            removedEmails: result.removedEmails,
            removedEvents: result.removedEvents,
          },
        });

        revalidatePathSafely("/settings/integrations");
        return { ok: true as const, data: result };
      },
    );
  });
}
