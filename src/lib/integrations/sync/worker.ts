import "server-only";

import { db } from "@/lib/db";
import { assertTenantContext } from "@/lib/documents/gate";
import { log } from "@/lib/logger";
import { emitEvent } from "@/lib/events";
import { PermanentJobError, RetryAfterError } from "@/lib/jobs";
import { restrictedIdsFor } from "@/lib/auth/access";
import { withTenantContext } from "@/lib/tenant-db";
import { accessTokenFor } from "@/lib/integrations/connections";
import { PROVIDERS, providerFor } from "@/lib/integrations/providers";
import {
  backfillStartUrl,
  calendarBackfillStartUrl,
  CursorExpiredError,
  fetchPage,
  incrementalStartUrl,
  MAX_BACKFILL_PAGES,
  MAX_INCREMENTAL_PAGES,
  RateLimitedError,
  type GraphEvent,
  type GraphMessage,
  type GraphPage,
  type Transport,
} from "@/lib/integrations/sync/graph";
import { GenerationChangedError, importPage } from "@/lib/integrations/sync/import";
import { importEventsPage } from "@/lib/integrations/sync/import-events";
import { syncEligibility } from "@/lib/integrations/sync/eligibility";
import { SecretUnreadableError } from "@/lib/crypto";

/**
 * One page of sync, as a job.
 *
 * Each run fetches a single page and, if there is more, enqueues itself again.
 * One page per job rather than a loop inside one job, because the queue
 * already provides what a loop would have to reinvent: a claim, a visibility
 * timeout, retries with backoff, a dead-letter state, and — the one that
 * matters here — a point between pages at which a disconnect can take effect.
 *
 * ## The cap belongs to the attempt, not the job
 *
 * `pagesImported` lives on the Integration row and is incremented inside the
 * page transaction, so forty queued jobs share one budget. A counter held in
 * the job payload would reset every time the chain re-enqueued itself, which
 * is the same as having no cap at all — the thing it is supposed to prevent is
 * precisely a backfill that keeps queueing more work.
 *
 * It is reset when a connection is made or remade, because that is a new
 * attempt. It is not reset by a retry, a resume, or a queued continuation.
 */

export const SYNC_JOB = "integration.sync";

/**
 * How many consecutive recoveries before the connection is left for a person.
 *
 * Recovery that never gives up is not resilience: it hides a connection that
 * is genuinely broken behind an infinite retry, which tells the customer the
 * same lie as a bare "Connected". At this count the scheduler stops returning
 * the connection and the interface says the sync needs attention, with
 * something to click.
 *
 * Defined here rather than in schedule.ts because schedule.ts imports this
 * module; the other direction would be a cycle.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

export type SyncPayload = {
  integrationId: string;
  /** The generation this chain belongs to. Carried, never re-read. */
  generation: number;
  /** Null on the first page of a backfill. */
  cursor: string | null;
  /**
   * Which kind of pass this is. Absent means `backfill`, so a job queued
   * before this field existed still runs as the backfill it was enqueued as.
   */
  mode?: "backfill" | "incremental";
  /**
   * Pages fetched so far **by this incremental chain**.
   *
   * Deliberately in the payload, which is exactly what the backfill cap must
   * never do. The two bounds are different in kind: a backfill's budget spans
   * every job of one attempt and has to survive re-enqueueing, so it lives on
   * the row; an incremental pass is a single short chain whose budget should
   * start again at the next pass, because the next pass is reading a different
   * and newer window. A row counter would make the second incremental run
   * inherit the first one's spend.
   */
  page?: number;
};

/** Enqueues the next page of an existing chain. */
export async function enqueueNextPage(input: {
  workspaceId: string;
  ownerUserId: string;
  payload: SyncPayload;
}): Promise<void> {
  await emitEvent({
    workspaceId: input.workspaceId,
    name: SYNC_JOB,
    entityType: "integration",
    entityId: input.payload.integrationId,
    // The owner, so the handler's tenant context is theirs — the Integration
    // row is readable only by its own user, and the import must be attributed
    // to them rather than to nobody.
    actorId: input.ownerUserId,
    payload: input.payload as unknown as Record<string, unknown>,
  });
}

/**
 * Starts a backfill. Called after a connection is made.
 *
 * Resets the page budget, because this is a new attempt, and clears the
 * truncation flag with it.
 */
export async function startBackfill(input: {
  integrationId: string;
  workspaceId: string;
  ownerUserId: string;
  generation: number;
}): Promise<void> {
  assertTenantContext("startBackfill");
  await db.integration.update({
    where: { id: input.integrationId },
    data: {
      pagesImported: 0,
      backfillTruncated: false,
      backfillCompletedAt: null,
      syncCursor: null,
      syncState: "backfilling",
    },
  });
  await enqueueNextPage({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    payload: { integrationId: input.integrationId, generation: input.generation, cursor: null },
  });
}

/**
 * Resumes a truncated backfill from where it stopped, at the customer's
 * request.
 *
 * Deliberately keeps `importedThrough` and the cursor, and gives a fresh page
 * budget — the cap exists to bound one unattended run, not to refuse a person
 * who has looked at the incomplete state and asked for more.
 */
export async function resumeBackfill(input: {
  integrationId: string;
  workspaceId: string;
  ownerUserId: string;
}): Promise<{ resumed: boolean }> {
  assertTenantContext("resumeBackfill");
  const row = await db.integration.findUnique({
    where: { id: input.integrationId },
    select: { syncCursor: true, syncGeneration: true, status: true, backfillTruncated: true },
  });
  if (!row || row.status !== "connected" || !row.backfillTruncated || !row.syncCursor) {
    return { resumed: false };
  }
  await db.integration.update({
    where: { id: input.integrationId },
    data: { pagesImported: 0, backfillTruncated: false, syncState: "backfilling" },
  });
  await enqueueNextPage({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    payload: {
      integrationId: input.integrationId,
      generation: row.syncGeneration,
      cursor: row.syncCursor,
    },
  });
  return { resumed: true };
}

/**
 * Queues an incremental pass over everything that arrived since the last one.
 *
 * Refuses unless the backfill has finished and is not truncated: an import
 * that has not reached the end of its window yet should finish that — or be
 * resumed — before it starts chasing new mail, or the two chains would race
 * for the same page budget and report nonsense progress.
 *
 * Returns what it decided and why, so the caller can log a skip rather than
 * guess at silence.
 */
export async function startIncremental(input: {
  integrationId: string;
  workspaceId: string;
  ownerUserId: string;
  /**
   * Recovering an interrupted chain rather than starting a routine pass.
   *
   * The only thing that may move a connection out of `syncing` or
   * `backfilling`, and the only thing that counts against the recovery bound.
   * The caller establishes that the chain is genuinely stopped — no live job,
   * stale enough, under the cap — see prisma/postgres/018 and schedule.ts.
   */
  recovering?: boolean;
  /** The customer pressing Retry: clears the bound rather than counting against it. */
  manual?: boolean;
}): Promise<{ queued: boolean; reason: string; recoveryAttempt?: number }> {
  assertTenantContext("startIncremental");
  const row = await db.integration.findUnique({
    where: { id: input.integrationId },
    select: {
      syncGeneration: true, status: true, syncState: true,
      backfillCompletedAt: true, backfillTruncated: true, recoveryAttempts: true,
    },
  });
  if (!row) return { queued: false, reason: "no such connection" };
  // Eligibility first, and identical for every caller. A disconnected,
  // errored, reauth-required, suspended or mock connection is never restarted
  // by anything here — recovery and Retry both come through this gate.
  if (row.status !== "connected") return { queued: false, reason: row.status };
  if (!row.backfillCompletedAt) return { queued: false, reason: "the backfill has not finished" };
  if (row.backfillTruncated) return { queued: false, reason: "the backfill is incomplete" };

  // Who the connection belongs to, and whether they may still sync — the
  // person, the membership, the flag and the plan, none of which
  // `Integration.status` knows anything about. Before any scheduling, so a
  // suspended account's connection is never queued in the first place.
  const eligibility = await syncEligibility({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
  });
  if (!eligibility.eligible) {
    return { queued: false, reason: eligibility.reason };
  }

  const interrupted = row.syncState !== "idle";
  if (interrupted && !(input.recovering || input.manual)) {
    // A routine pass keeps the strict rule: a chain that is running owns the
    // connection's cursor and page budget, and a second one racing it would
    // corrupt both.
    return { queued: false, reason: `already ${row.syncState}` };
  }

  const attempts = input.manual
    ? 0
    : input.recovering && interrupted
      ? row.recoveryAttempts + 1
      : row.recoveryAttempts;
  if (!input.manual && attempts > MAX_RECOVERY_ATTEMPTS) {
    // Belt and braces: the scan already excludes these. If it ever stops
    // doing so, recovery still stops here rather than looping.
    return { queued: false, reason: "recovery attempts exhausted" };
  }

  // A compare-and-set on the generation, so a disconnect racing the scheduler
  // cannot have a job queued against it. `updateMany` with the generation in
  // the WHERE takes the row lock the same way the page importer's does; zero
  // rows means the connection moved and this scheduling must not happen.
  const claimed = await db.integration.updateMany({
    where: {
      id: input.integrationId,
      syncGeneration: row.syncGeneration,
      status: "connected",
    },
    data: { syncState: "syncing", recoveryAttempts: attempts },
  });
  if (claimed.count === 0) {
    return { queued: false, reason: "the connection moved while it was being scheduled" };
  }

  await enqueueNextPage({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    payload: {
      integrationId: input.integrationId,
      // Carried from the row read above, and the compare-and-set just proved
      // it is still current. A job carrying a stale generation stands down.
      generation: row.syncGeneration,
      // Null: a recovered chain starts a fresh incremental pass from
      // `lastSyncAt` rather than resuming a cursor whose position is no
      // longer trustworthy. De-duplication makes the overlap free.
      cursor: null,
      mode: "incremental",
      page: 0,
    },
  });
  return { queued: true, reason: "queued", recoveryAttempt: attempts };
}

/** The handler. `transport` is injectable so tests never reach Graph. */
export async function runSyncPage(
  payload: SyncPayload,
  options: { transport?: Transport } = {},
): Promise<{ imported: number; duplicates: number; done: boolean; truncated: boolean }> {
  // The job runner establishes the context from the event's workspace and
  // actor. Asserting it here means a caller that forgets fails loudly instead
  // of reading an empty Integration row as "disconnected" and standing down —
  // which is silent, permanent, and indistinguishable from working correctly.
  assertTenantContext("runSyncPage");
  const row = await db.integration.findUnique({
    where: { id: payload.integrationId },
    select: {
      id: true, workspaceId: true, userId: true, provider: true, status: true,
      accountEmail: true, syncGeneration: true, syncCursor: true, lastSyncAt: true,
    },
  });

  // A connection that is gone, disconnected, or has moved on is not a failure
  // to retry — it is a job that should stop existing.
  if (!row) throw new PermanentJobError(`integration ${payload.integrationId} no longer exists`);
  if (row.status !== "connected") {
    log.info("sync job standing down", { reason: row.status, integrationId: row.id });
    return { imported: 0, duplicates: 0, done: true, truncated: false };
  }
  if (row.syncGeneration !== payload.generation) {
    log.info("sync job standing down", {
      reason: "generation moved",
      carried: payload.generation,
      current: row.syncGeneration,
    });
    return { imported: 0, duplicates: 0, done: true, truncated: false };
  }

  // Asked again here, not only when this job was scheduled. The gap between
  // queueing and running is minutes wide and spans exactly the moment an
  // operator suspends an account, removes a member, switches the flag off or
  // a grant expires. A scheduling-time check cannot reach a job that is
  // already in the queue; this one can, and it runs before a single byte is
  // fetched from the provider.
  //
  // `done: true` rather than throwing: this is not a failure to retry. The
  // chain stops, nothing is enqueued after it, and the connection is left
  // exactly as it is for the customer to see.
  const eligibility = await syncEligibility({
    workspaceId: row.workspaceId,
    ownerUserId: row.userId,
  });
  if (!eligibility.eligible) {
    log.info("sync job standing down", {
      reason: eligibility.reason,
      integrationId: row.id,
    });
    await db.integration.updateMany({
      where: { id: row.id, syncGeneration: payload.generation },
      data: { syncState: "idle" },
    });
    return { imported: 0, duplicates: 0, done: true, truncated: false };
  }

  const provider = providerFor(row.provider) ?? PROVIDERS.outlook;

  // A credential that cannot be decrypted is not a transient failure.
  //
  // `AUTH_SECRET` derives the key, so a rotation — or a tampered row — makes
  // every stored token unreadable at once. `accessTokenFor` has already done
  // the right thing by the time this throws: the connection is marked
  // `reauth_required`, the unreadable credential is destroyed, and a message
  // the customer can act on is stored. What was missing was stopping. Letting
  // the error out marks the job failed and schedules a retry, and a retry
  // cannot make a key come back — it just burns an attempt, waits out a
  // backoff, and on the next run stands down anyway because the status has
  // changed. Standing down here makes "stops retrying" true rather than
  // nearly true.
  let token: string;
  try {
    token = await accessTokenFor(row.id, provider, options.transport);
  } catch (error) {
    if (error instanceof SecretUnreadableError) {
      log.warn("sync job standing down", {
        reason: "credentials could not be read",
        integrationId: row.id,
      });
      await db.integration.updateMany({
        where: { id: row.id, syncGeneration: payload.generation },
        data: { syncState: "idle" },
      });
      return { imported: 0, duplicates: 0, done: true, truncated: false };
    }
    throw error;
  }

  // An incremental pass with no `lastSyncAt` has no "since" to read from.
  // Rather than invent one — midnight, or the epoch, both of which import the
  // wrong thing — it falls back to the bounded backfill window, which is the
  // same question asked safely.
  const incremental = payload.mode === "incremental";

  // Calendar and mail are different endpoints with different shapes, so the
  // kind is decided once, here, from the provider's own definition rather than
  // from the payload — a job cannot ask for a mailbox read against a calendar
  // connection.
  const isCalendar = provider.kind === "calendar";

  // A calendar's incremental pass re-reads the same window rather than asking
  // for "what arrived since". There is no calendar equivalent of
  // `receivedDateTime ge …` that catches a meeting which *moved*: a meeting
  // rescheduled from next week to next month changes nothing about when it
  // was created, so a since-filter would miss exactly the change that matters
  // most. The window is bounded and small, and the importer updates in place,
  // so re-reading it is both cheap and the only correct option.
  const url =
    payload.cursor ??
    (isCalendar
      ? calendarBackfillStartUrl()
      : incremental && row.lastSyncAt
        ? incrementalStartUrl(row.lastSyncAt)
        : backfillStartUrl());

  let page: GraphPage<GraphMessage | GraphEvent>;
  try {
    page = await fetchPage<GraphMessage | GraphEvent>(url, token, options.transport);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      // Pushed out to what the provider asked for. The runner takes the later
      // of this and its own backoff, so this can only delay the retry.
      throw new RetryAfterError(
        error.retryAfterSeconds * 1000,
        `the provider asked for ${error.retryAfterSeconds}s`,
      );
    }
    if (error instanceof CursorExpiredError) {
      // A dead cursor cannot be retried into life. Start the window again
      // from the beginning: the page write de-duplicates on
      // (workspace, owner, provider, externalId), so re-reading what we
      // already have imports nothing twice, and anything already imported
      // keeps its privacy and its owner because those rows are not rewritten.
      log.warn("sync cursor expired; restarting the window", { integrationId: row.id });
      await db.integration.update({
        where: { id: row.id },
        data: { syncCursor: null, pagesImported: 0, backfillTruncated: false, syncState: "backfilling" },
      });
      await enqueueNextPage({
        workspaceId: row.workspaceId,
        ownerUserId: row.userId,
        payload: { integrationId: row.id, generation: row.syncGeneration, cursor: null },
      });
      return { imported: 0, duplicates: 0, done: false, truncated: false };
    }
    throw error;
  }

  // The owner's own record scope, so a restricted member's mail is never
  // linked to a contact they may not see. The job's ambient context is
  // unrestricted, so this is established explicitly rather than inherited.
  const memberships = await db.workspaceMember.findMany({
    where: { userId: row.userId },
    select: { workspaceId: true, scopeMode: true },
  });
  const restricted = restrictedIdsFor(
    memberships.map((m) => ({ id: m.workspaceId, scopeMode: m.scopeMode })),
    [row.workspaceId],
  );

  let result: { imported: number; duplicates: number; truncated: boolean };
  try {
    result = await withTenantContext(
      { workspaceIds: [row.workspaceId], userId: row.userId, restrictedWorkspaceIds: restricted },
      async () => {
        const common = {
          integrationId: row.id,
          workspaceId: row.workspaceId,
          ownerUserId: row.userId,
          accountEmail: row.accountEmail,
          generation: payload.generation,
          nextCursor: page.nextLink,
          incremental,
          visibleContactWhere: { workspaceId: row.workspaceId },
        };
        if (isCalendar) {
          const events = await importEventsPage({ ...common, events: page.items as GraphEvent[] });
          // `updated` counts as neither imported nor duplicated: a meeting
          // that moved is new information, and reporting it as a duplicate
          // would say nothing happened when something did.
          return {
            imported: events.imported,
            duplicates: events.updated,
            truncated: events.truncated,
          };
        }
        const mail = await importPage({ ...common, messages: page.items as GraphMessage[] });
        return { imported: mail.imported, duplicates: mail.duplicates, truncated: mail.truncated };
      },
    );
  } catch (error) {
    if (error instanceof GenerationChangedError) {
      // The disconnect won the race. Not a failure: the job has simply been
      // overtaken and must not be retried.
      log.info("sync page abandoned", { integrationId: row.id, reason: "generation moved" });
      return { imported: 0, duplicates: 0, done: true, truncated: false };
    }
    throw error;
  }

  // An incremental chain is bounded by its own page count, carried in the
  // payload. Hitting the bound stops the chain rather than queueing more: the
  // next scheduled pass will read from `lastSyncAt`, which this pass has been
  // advancing all along, so stopping early loses nothing but time.
  const pagesSoFar = (payload.page ?? 0) + 1;
  const outOfIncrementalPages = incremental && pagesSoFar >= MAX_INCREMENTAL_PAGES;

  const done = !page.nextLink || result.truncated || outOfIncrementalPages;
  if (!done) {
    await enqueueNextPage({
      workspaceId: row.workspaceId,
      ownerUserId: row.userId,
      payload: {
        integrationId: row.id,
        generation: payload.generation,
        cursor: page.nextLink,
        ...(incremental ? { mode: "incremental" as const, page: pagesSoFar } : {}),
      },
    });
  } else if (outOfIncrementalPages) {
    // Leave no chain half-open: the row says `syncing` while a chain is
    // running, and nothing else will clear it once this one stops.
    await db.integration.update({
      where: { id: row.id },
      data: { syncState: "idle" },
    });
    log.warn("incremental pass stopped at its page cap", {
      integrationId: row.id,
      cap: MAX_INCREMENTAL_PAGES,
    });
  } else if (result.truncated) {
    log.warn("backfill stopped at the page cap", {
      integrationId: row.id,
      cap: MAX_BACKFILL_PAGES,
    });
  }

  return {
    imported: result.imported,
    duplicates: result.duplicates,
    done,
    truncated: result.truncated,
  };
}
