import "server-only";

import { db, rootDb } from "@/lib/db";
import { isPostgres } from "@/lib/env";
import { log } from "@/lib/logger";
import { withTenantContext, NO_RECORD_READS } from "@/lib/tenant-db";
import { startIncremental } from "@/lib/integrations/sync/worker";

/**
 * Queueing the incremental passes.
 *
 * Connecting starts a backfill, and the backfill's chain carries itself to the
 * end of its window. Nothing then happens again — a mailbox imported once and
 * went quiet — because no part of the system went looking for connections that
 * had fallen behind. This is that part.
 *
 * ## Why a scan and not a self-perpetuating chain
 *
 * The cheaper design is for each pass to queue the next one before it
 * finishes. It needs no privileged read and no scheduler. It also stops
 * forever the first time a chain dead-letters, with nothing to notice and
 * nothing to restart it — a connection that silently stops syncing while still
 * displaying "Connected" is the exact failure this release has already been
 * bitten by twice. A scan is self-healing by construction: whatever happened
 * last time, a connection that is behind is picked up on the next tick.
 */

/** How stale a connection must be before an incremental pass is queued. */
export const SYNC_INTERVAL_MS = 30 * 60_000;

/** Connections queued per tick, so one scan cannot flood the queue. */
export const SCHEDULE_BATCH = 50;

type DueConnection = {
  id: string;
  workspaceId: string;
  userId: string;
  syncGeneration: number;
};

/**
 * The connections that are behind, across every tenant.
 *
 * On PostgreSQL this **must** go through `app_due_integrations`. `Integration`
 * carries a RESTRICTIVE policy keyed on `app_user_id()` and has RLS FORCED, so
 * the table owner is subject to it too: an ordinary scan with no tenant
 * context matches no rows and raises no error. The scheduler would appear to
 * work and would schedule nothing, forever. See prisma/postgres/017.
 *
 * On SQLite there are no policies, so the same question is an ordinary query.
 * `rootDb` rather than `db` because there is no tenant context here by
 * design — this is the one step that is deliberately cross-tenant, and it is
 * confined to these few lines.
 */
async function dueConnections(idleMs: number, limit: number): Promise<DueConnection[]> {
  const cutoff = new Date(Date.now() - idleMs);

  if (isPostgres) {
    return rootDb.$queryRaw<DueConnection[]>`
      SELECT * FROM app_due_integrations(${Math.floor(idleMs / 1000)}::int, ${limit}::int)
    `;
  }

  const rows = await rootDb.integration.findMany({
    where: {
      status: "connected",
      backfillCompletedAt: { not: null },
      backfillTruncated: false,
      syncState: "idle",
      lastSyncAt: { not: null, lt: cutoff },
    },
    select: { id: true, workspaceId: true, userId: true, syncGeneration: true },
    orderBy: { lastSyncAt: "asc" },
    take: limit,
  });
  return rows;
}

/**
 * Queues an incremental pass for every connection that is behind.
 *
 * Each one is queued inside its **own** tenant context, with its owner as the
 * actor, so the privileged step ends with the listing above: `startIncremental`
 * re-reads the connection under that tenant's policies and refuses if anything
 * has changed since the scan — a disconnect between the two is therefore a
 * no-op rather than a job queued against a dead grant.
 */
export async function scheduleDueSyncs(
  options: { idleMs?: number; limit?: number } = {},
): Promise<{ considered: number; queued: number; skipped: number }> {
  const idleMs = options.idleMs ?? SYNC_INTERVAL_MS;
  const limit = options.limit ?? SCHEDULE_BATCH;

  const due = await dueConnections(idleMs, limit);
  let queued = 0;
  let skipped = 0;

  for (const connection of due) {
    try {
      const result = await withTenantContext(
        {
          workspaceIds: [connection.workspaceId],
          userId: connection.userId,
          restrictedWorkspaceIds: NO_RECORD_READS,
        },
        () =>
          startIncremental({
            integrationId: connection.id,
            workspaceId: connection.workspaceId,
            ownerUserId: connection.userId,
          }),
      );
      if (result.queued) queued += 1;
      else skipped += 1;
    } catch (error) {
      // One connection that cannot be scheduled must not stop the rest. The
      // next tick will try it again.
      skipped += 1;
      log.warn("could not schedule an incremental sync", {
        integrationId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (due.length > 0) {
    log.info("incremental syncs scheduled", { considered: due.length, queued, skipped });
  }
  return { considered: due.length, queued, skipped };
}

/** Exported for the test that proves the SQLite and PostgreSQL paths agree. */
export const __scheduleInternals = { dueConnections, db };
