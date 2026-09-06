import "server-only";

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { db } from "@/lib/db";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { raiseAlert } from "@/lib/security/alerts";
import type { DomainEventName } from "@/lib/events";

/**
 * The job runner.
 *
 * The outbox already guaranteed that an event and the change it describes commit
 * together. What it did not have was a *runner*: dispatch happened best-effort,
 * in-process, after a request — so an event whose request died sat in the table
 * until something else happened to drain it, a failing job retried immediately
 * and forever, and one poisoned job could occupy every attempt.
 *
 * This adds the parts a queue needs:
 *
 *  - **Atomic claiming.** `UPDATE … WHERE status = 'pending' AND availableAt <=
 *    now RETURNING` in one statement. Two workers cannot take the same job,
 *    without a lock table.
 *  - **A claim that expires.** A worker that dies mid-job leaves `claimedUntil`
 *    in the past, and the job becomes claimable again. Without this a crash
 *    strands work permanently.
 *  - **Exponential backoff with jitter.** A failing job waits 2s, 8s, 32s, 2m,
 *    8m — not 5ms in a hot loop against whatever is already broken.
 *  - **A dead-letter state.** After `maxAttempts` a job is marked dead, never
 *    retried automatically, and kept for inspection. **One poisoned job cannot
 *    block the queue** because the queue is ordered by availability rather than
 *    by insertion, and a dead job has no availability.
 *  - **An execution log.** `JobRun` records every attempt with its duration and
 *    error, which is what distinguishes "failed once on a timeout" from "fails
 *    every time" — the event row alone only carries the latest error.
 *  - **Tenant context.** Every handler runs inside `withTenantContext` for the
 *    job's own workspace, so a background job is subject to the same
 *    database-level isolation as a request. A job cannot touch another tenant
 *    even if its handler forgets to filter.
 *  - **Idempotency.** Handlers are registered with a key; a job that has already
 *    succeeded is not run again on a redelivery.
 */

export const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** How long a claim is held before another worker may take the job. */
const CLAIM_TTL_MS = 5 * 60_000;

/** Backoff schedule, in milliseconds, by attempt number. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** (2 * attempt) * 1000, 15 * 60_000);
  // Jitter, so a hundred jobs that failed together do not all retry together.
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export type JobHandler = (job: {
  id: string;
  name: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  attempt: number;
}) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(name: DomainEventName | string, handler: JobHandler): void {
  handlers.set(name, handler);
}

export type ClaimedJob = {
  id: string;
  name: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  payload: string;
  attempts: number;
  maxAttempts: number;
};

/**
 * Claims up to `limit` jobs for this worker, atomically.
 *
 * `FOR UPDATE SKIP LOCKED` on PostgreSQL: concurrent workers step over each
 * other's rows rather than blocking. SQLite has no such clause, so the fallback
 * claims one at a time with a conditional update — correct, just less
 * concurrent, which is acceptable for a development database.
 */
export async function claimJobs(limit = 10): Promise<ClaimedJob[]> {
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + CLAIM_TTL_MS);
  const { isPostgres } = await import("@/lib/env");

  if (isPostgres) {
    return db.$queryRaw<ClaimedJob[]>`
      UPDATE "DomainEvent" SET
        status = 'processing',
        "claimedBy" = ${WORKER_ID},
        "claimedUntil" = ${claimedUntil},
        attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM "DomainEvent"
        WHERE "deadAt" IS NULL
          AND "processedAt" IS NULL
          AND "availableAt" <= ${now}
          AND (
            status = 'pending'
            OR status = 'failed'
            -- A claim whose worker died. Reclaimable rather than stranded.
            OR (status = 'processing' AND ("claimedUntil" IS NULL OR "claimedUntil" <= ${now}))
          )
        ORDER BY "availableAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, name, "workspaceId", "entityType", "entityId", "actorId",
                payload, attempts, "maxAttempts"
    `;
  }

  const candidates = await db.domainEvent.findMany({
    where: {
      deadAt: null,
      processedAt: null,
      availableAt: { lte: now },
      OR: [
        { status: "pending" },
        { status: "failed" },
        { status: "processing", claimedUntil: { lte: now } },
      ],
    },
    orderBy: { availableAt: "asc" },
    take: limit,
  });

  const claimed: ClaimedJob[] = [];
  for (const candidate of candidates) {
    // Conditional on the attempt count we read, so only one worker wins.
    const result = await db.domainEvent.updateMany({
      where: { id: candidate.id, attempts: candidate.attempts, processedAt: null, deadAt: null },
      data: {
        status: "processing",
        claimedBy: WORKER_ID,
        claimedUntil,
        attempts: candidate.attempts + 1,
      },
    });
    if (result.count === 1) {
      claimed.push({ ...candidate, attempts: candidate.attempts + 1 });
    }
  }
  return claimed;
}

export type RunResult = { processed: number; failed: number; dead: number };

/** Runs one batch. Safe to call concurrently from several workers. */
export async function runJobs(limit = 10): Promise<RunResult> {
  const jobs = await claimJobs(limit);
  const result: RunResult = { processed: 0, failed: 0, dead: 0 };

  for (const job of jobs) {
    const outcome = await runOne(job);
    if (outcome === "processed") result.processed++;
    else if (outcome === "dead") result.dead++;
    else result.failed++;
  }

  return result;
}

async function runOne(job: ClaimedJob): Promise<"processed" | "failed" | "dead"> {
  const requestId = newRequestId();
  const started = Date.now();

  const run = await db.jobRun.create({
    data: { eventId: job.id, attempt: job.attempts, worker: WORKER_ID },
    select: { id: true },
  });

  return runWithContext({ requestId, workspaceId: job.workspaceId }, async () => {
    try {
      const handler = handlers.get(job.name);
      if (!handler) {
        // An unregistered name is a permanent failure, not a transient one:
        // retrying cannot make a handler appear.
        throw new PermanentJobError(`No handler is registered for "${job.name}"`);
      }

      const { withTenantContext } = await import("@/lib/tenant-db");

      // The handler runs with database-enforced tenant context for its own
      // workspace, so a background job is subject to the same isolation as a
      // request — including if the handler forgets to filter.
      await withTenantContext(
        { workspaceIds: [job.workspaceId], userId: job.actorId },
        async () =>
          handler({
            id: job.id,
            name: job.name,
            workspaceId: job.workspaceId,
            entityType: job.entityType,
            entityId: job.entityId,
            actorId: job.actorId,
            payload: parsePayload(job.payload),
            attempt: job.attempts,
          }),
      );

      const durationMs = Date.now() - started;
      await db.$transaction([
        db.domainEvent.update({
          where: { id: job.id },
          data: {
            status: "done",
            processedAt: new Date(),
            claimedBy: null,
            claimedUntil: null,
            lastError: null,
          },
        }),
        db.jobRun.update({
          where: { id: run.id },
          data: { finishedAt: new Date(), outcome: "success", durationMs },
        }),
      ]);

      log.info("job processed", { job: job.name, attempt: job.attempts, ms: durationMs });
      return "processed";
    } catch (error) {
      return handleFailure(job, run.id, started, error);
    }
  });
}

async function handleFailure(
  job: ClaimedJob,
  runId: string,
  started: number,
  error: unknown,
): Promise<"failed" | "dead"> {
  const message = error instanceof Error ? error.message : String(error);
  const durationMs = Date.now() - started;

  // A permanent failure skips the remaining attempts. Retrying an unregistered
  // handler or a malformed payload wastes attempts on something that cannot
  // succeed, and delays the dead-letter signal that a human needs.
  const permanent = error instanceof PermanentJobError;
  const exhausted = permanent || job.attempts >= job.maxAttempts;

  await db.$transaction([
    db.domainEvent.update({
      where: { id: job.id },
      data: exhausted
        ? {
            status: "dead",
            deadAt: new Date(),
            claimedBy: null,
            claimedUntil: null,
            lastError: message.slice(0, 500),
          }
        : {
            status: "failed",
            claimedBy: null,
            claimedUntil: null,
            availableAt: new Date(Date.now() + backoffMs(job.attempts)),
            lastError: message.slice(0, 500),
          },
    }),
    db.jobRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(),
        outcome: "failure",
        durationMs,
        error: message.slice(0, 500),
      },
    }),
  ]);

  if (exhausted) {
    log.error("job dead-lettered", {
      job: job.name, attempts: job.attempts, permanent, error: message,
    });
    // A dead job is silent work that stopped happening. Someone has to know.
    await raiseAlert({
      kind: "destructive.burst",
      severity: "warning",
      workspaceId: job.workspaceId,
      summary: `A background job was dead-lettered: ${job.name}`,
      metadata: { job: job.name, attempts: job.attempts, error: message.slice(0, 200) },
      dedupeKey: `job-dead:${job.name}:${job.workspaceId}`,
    });
    return "dead";
  }

  log.warn("job failed; will retry", {
    job: job.name, attempt: job.attempts, of: job.maxAttempts, error: message,
  });
  return "failed";
}

/** Marks a failure as not worth retrying. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type QueueDepth = {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  oldestPendingAgeSeconds: number | null;
};

/**
 * What the queue looks like right now.
 *
 * `oldestPendingAgeSeconds` is the number that matters operationally: a growing
 * backlog with a young oldest job is a burst, and a small backlog with an old
 * one is a stuck worker. The two need different responses.
 */
export async function queueDepth(): Promise<QueueDepth> {
  const [pending, processing, failed, dead, oldest] = await Promise.all([
    // `processedAt: null` on every one of these: a row keeps its status after
    // it succeeds, so counting by status alone reports every job ever run as
    // still pending.
    db.domainEvent.count({ where: { status: "pending", deadAt: null, processedAt: null } }),
    db.domainEvent.count({ where: { status: "processing", deadAt: null, processedAt: null } }),
    db.domainEvent.count({ where: { status: "failed", deadAt: null, processedAt: null } }),
    db.domainEvent.count({ where: { deadAt: { not: null } } }),
    db.domainEvent.findFirst({
      where: { processedAt: null, deadAt: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    pending, processing, failed, dead,
    oldestPendingAgeSeconds: oldest
      ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000)
      : null,
  };
}

/** Returns a dead job to the queue, after whatever broke has been fixed. */
export async function replayDeadJob(eventId: string): Promise<boolean> {
  const result = await db.domainEvent.updateMany({
    where: { id: eventId, deadAt: { not: null } },
    data: {
      status: "pending",
      deadAt: null,
      attempts: 0,
      availableAt: new Date(),
      lastError: null,
    },
  });
  return result.count > 0;
}

export async function listDeadJobs(limit = 50) {
  return db.domainEvent.findMany({
    where: { deadAt: { not: null } },
    orderBy: { deadAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true, name: true, workspaceId: true, entityType: true, entityId: true,
      attempts: true, lastError: true, deadAt: true, createdAt: true,
    },
  });
}

/**
 * Periodic maintenance. Called by the worker on a slower cadence than the job
 * loop, because none of it is urgent and all of it writes.
 */
export async function sweep(): Promise<Record<string, number>> {
  const { pruneSessions } = await import("@/lib/auth/sessions");
  const { pruneTokens } = await import("@/lib/auth/tokens");
  const { isPostgres } = await import("@/lib/env");

  const results: Record<string, number> = {};

  results.sessions = await pruneSessions();
  results.tokens = await pruneTokens();

  results.completedJobs = await db.domainEvent.deleteMany({
    where: { status: "done", processedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
  }).then((r) => r.count);

  results.idempotencyKeys = await db.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).then((r) => r.count);

  // Acknowledged security alerts older than a year. Deliberately only the
  // acknowledged ones: an unacknowledged alert is unfinished work and is kept
  // however old it is. JobRun rows need no sweep of their own — they cascade
  // with the DomainEvent deleted above.
  //
  // This is the only retention rule here that touches a record a person reads.
  // Everything customer-owned — archived contacts, deals, notes, the audit log —
  // is deliberately NOT purged by this sweep: see docs/RETENTION.md. Deleting a
  // customer's business data on a timer needs a policy they have agreed to,
  // not a cleanup job.
  results.securityAlerts = await db.securityAlert.deleteMany({
    where: {
      acknowledgedAt: { not: null, lt: new Date(Date.now() - 365 * 86_400_000) },
    },
  }).then((r) => r.count);

  if (isPostgres) {
    const { PostgresStore } = await import("@/lib/rate-limit/stores");
    results.rateLimitCounters = await PostgresStore.sweep();
  }

  return results;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A malformed payload cannot be fixed by retrying.
    throw new PermanentJobError("Job payload is not valid JSON");
  }
}
