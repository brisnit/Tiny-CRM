import "server-only";

import { db, rootDb } from "@/lib/db";
import { isPostgres } from "@/lib/env";
import { log } from "@/lib/logger";
import { withTenantContext, NO_RECORD_READS } from "@/lib/tenant-db";
import { MAX_RECOVERY_ATTEMPTS, startIncremental } from "@/lib/integrations/sync/worker";

export { MAX_RECOVERY_ATTEMPTS };

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

/**
 * How long a connection must sit mid-chain before it counts as interrupted.
 *
 * Generous on purpose. A chain that is simply slow — a large page, a throttled
 * provider, a retry waiting out its backoff — must not be mistaken for one
 * that stopped, or recovery would start a second chain against a connection
 * that is working. Four times the sync interval is longer than any legitimate
 * pass, and the live-job check below is the real guard; this is the backstop
 * for the case where no job row survives at all.
 */
export const STALE_AFTER_MS = 4 * SYNC_INTERVAL_MS;

/** Connections queued per tick, so one scan cannot flood the queue. */
export const SCHEDULE_BATCH = 50;

type DueConnection = {
  id: string;
  workspaceId: string;
  userId: string;
  syncGeneration: number;
  /** 'due' for an ordinary overdue pass, 'recovery' for an interrupted chain. */
  reason: string;
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
async function dueConnections(
  idleMs: number,
  staleMs: number,
  maxRecovery: number,
  limit: number,
): Promise<DueConnection[]> {
  if (isPostgres) {
    return rootDb.$queryRaw<DueConnection[]>`
      SELECT * FROM app_due_integrations(
        ${Math.floor(idleMs / 1000)}::int,
        ${Math.floor(staleMs / 1000)}::int,
        ${maxRecovery}::int,
        ${limit}::int
      )
    `;
  }

  // The SQLite half of the same question. Kept deliberately close in shape to
  // prisma/postgres/018 — the two have to agree, and the tests run on both.
  const candidates = await rootDb.integration.findMany({
    where: {
      status: "connected",
      backfillCompletedAt: { not: null },
      backfillTruncated: false,
      lastSyncAt: { not: null },
      recoveryAttempts: { lt: maxRecovery },
      OR: [
        { syncState: "idle", lastSyncAt: { lt: new Date(Date.now() - idleMs) } },
        {
          syncState: { in: ["syncing", "backfilling"] },
          lastSyncAt: { lt: new Date(Date.now() - staleMs) },
        },
      ],
    },
    select: { id: true, workspaceId: true, userId: true, syncGeneration: true, syncState: true },
    orderBy: { lastSyncAt: "asc" },
    take: limit,
  });
  if (candidates.length === 0) return [];

  // Bound 1, as a second query because SQLite has no lateral NOT EXISTS in
  // Prisma's filter language. A connection with a live job belongs to the
  // queue: restarting it would run two chains against one cursor.
  const live = await rootDb.domainEvent.findMany({
    where: {
      name: "integration.sync",
      entityId: { in: candidates.map((c) => c.id) },
      status: { in: ["pending", "failed", "processing"] },
    },
    select: { entityId: true },
  });
  const busy = new Set(live.map((e) => e.entityId));

  return candidates
    .filter((c) => !busy.has(c.id))
    .map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      userId: c.userId,
      syncGeneration: c.syncGeneration,
      reason: c.syncState === "idle" ? "due" : "recovery",
    }));
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
  options: { idleMs?: number; staleMs?: number; maxRecovery?: number; limit?: number } = {},
): Promise<{
  considered: number;
  queued: number;
  recovered: number;
  skipped: number;
}> {
  const idleMs = options.idleMs ?? SYNC_INTERVAL_MS;
  const staleMs = options.staleMs ?? STALE_AFTER_MS;
  const maxRecovery = options.maxRecovery ?? MAX_RECOVERY_ATTEMPTS;
  const limit = options.limit ?? SCHEDULE_BATCH;

  const due = await dueConnections(idleMs, staleMs, maxRecovery, limit);
  let queued = 0;
  let recovered = 0;
  let skipped = 0;

  for (const connection of due) {
    const isRecovery = connection.reason === "recovery";
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
            // Only a recovery may move a row out of `syncing`, and only a
            // recovery counts against the bound. An ordinary pass keeps the
            // strict `idle` requirement, so a bug in the scan cannot turn a
            // routine tick into a restart of a running chain.
            recovering: isRecovery,
          }),
      );
      if (result.queued) {
        queued += 1;
        if (isRecovery) {
          recovered += 1;
          log.warn("recovering an interrupted sync", {
            integrationId: connection.id,
            attempt: result.recoveryAttempt,
            of: maxRecovery,
          });
        }
      } else {
        skipped += 1;
      }
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
    log.info("incremental syncs scheduled", { considered: due.length, queued, recovered, skipped });
  }
  return { considered: due.length, queued, recovered, skipped };
}

/** Exported for the test that proves the SQLite and PostgreSQL paths agree. */
export const __scheduleInternals = { dueConnections, db };
