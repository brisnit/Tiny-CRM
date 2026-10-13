import "server-only";

import { db } from "@/lib/db";
import { assertTenantContext } from "@/lib/documents/gate";
import { log } from "@/lib/logger";
import { associateContact, candidateAddresses } from "@/lib/integrations/sync/associate";
import {
  MAX_BACKFILL_PAGES,
  type GraphMessage,
} from "@/lib/integrations/sync/graph";

/**
 * Writing one page of imported mail, and advancing the cursor, atomically.
 *
 * ## The race this is built around
 *
 * A disconnect must stop an import that is already running. Checking
 * `syncGeneration` when the job starts cannot do that: the job then fetches a
 * page over the network, which takes seconds, and a disconnect landing in that
 * window is invisible to a check that already happened.
 *
 * Checking again inside the writing transaction is necessary but **still not
 * sufficient** on its own. Under READ COMMITTED, a plain read of the
 * generation followed by writes can interleave with a disconnect that commits
 * between the two — the read sees the old value, the writes proceed, and the
 * page lands after the customer disconnected.
 *
 * So the check is a **compare-and-set, performed first**:
 *
 *     UPDATE "Integration" SET cursor = …, pages = …
 *      WHERE id = … AND "syncGeneration" = <the generation this job carries>
 *
 * That statement takes the row lock. A concurrent disconnect's own UPDATE on
 * the same row blocks until this transaction commits or rolls back, and then
 * bumps the generation. If the disconnect got there first, this UPDATE matches
 * **zero rows** — and zero is the signal to abort, which rolls the whole page
 * back. The messages and the cursor move together or not at all.
 *
 * Doing the CAS first rather than last is the part that matters: it acquires
 * the lock before any message is written, so there is no window in which rows
 * exist for a connection that has since been disconnected.
 */

export class GenerationChangedError extends Error {
  constructor(expected: number) {
    super(`the connection moved past generation ${expected} while this page was in flight`);
    this.name = "GenerationChangedError";
  }
}

export type ImportPageInput = {
  integrationId: string;
  workspaceId: string;
  ownerUserId: string;
  accountEmail: string | null;
  /** The generation this job was enqueued under. */
  generation: number;
  messages: GraphMessage[];
  /** Where to resume, or null when this was the last page. */
  nextCursor: string | null;
  /** The scope clause the connecting person reads contacts through. */
  visibleContactWhere: Record<string, unknown>;
  /** True for the incremental pass, which does not count against the cap. */
  incremental?: boolean;
};

export type ImportPageResult = {
  imported: number;
  /** Already present, so skipped. Re-running a page is not a duplicate. */
  duplicates: number;
  linked: number;
  /** Why the unlinked ones were not linked, for the customer-facing summary. */
  unlinked: Record<string, number>;
  oldest: Date | null;
  /** True when the page cap stopped this backfill short. */
  truncated: boolean;
};

export async function importPage(input: ImportPageInput): Promise<ImportPageResult> {
  /**
   * Without a tenant context this fails in the worst possible way.
   *
   * `Integration` is under a restrictive policy keyed on `app_user_id()`, so a
   * context-less connection matches **no rows** — and the compare-and-set
   * below reads zero rows as "the generation moved", which is a completely
   * wrong diagnosis. The worker would conclude the customer had disconnected
   * and stop, quietly and permanently, with nothing in the logs but a
   * generation message.
   *
   * Found exactly that way: the first run of the race tests reported
   * GenerationChangedError on a connection whose generation had not changed.
   */
  assertTenantContext("importPage");
  return db.$transaction(async (tx) => {
    // ---- The compare-and-set, before anything is written -----------------
    const pagesIncrement = input.incremental ? 0 : 1;
    const claimed = await tx.integration.updateMany({
      where: {
        id: input.integrationId,
        syncGeneration: input.generation,
        // A disconnect also changes status, so this is belt and braces: the
        // generation alone is the authority.
        status: "connected",
      },
      data: {
        syncCursor: input.nextCursor,
        pagesImported: { increment: pagesIncrement },
        lastSyncAt: new Date(),
        syncState: input.nextCursor
          ? input.incremental
            ? "syncing"
            : "backfilling"
          : "idle",
      },
    });
    if (claimed.count === 0) throw new GenerationChangedError(input.generation);

    // Re-read inside the same transaction, now that the row is locked, to
    // learn the page count the increment produced.
    const state = await tx.integration.findUniqueOrThrow({
      where: { id: input.integrationId },
      select: { pagesImported: true, importedThrough: true },
    });
    const truncated = !input.incremental && state.pagesImported >= MAX_BACKFILL_PAGES && Boolean(input.nextCursor);

    // ---- The page itself -------------------------------------------------
    let imported = 0;
    let duplicates = 0;
    let linked = 0;
    const unlinked: Record<string, number> = {};
    let oldest: Date | null = null;

    for (const message of input.messages) {
      const externalId = message.id;
      if (!externalId) continue;

      const sentAt = message.receivedDateTime ? new Date(message.receivedDateTime) : new Date();
      if (!oldest || sentAt < oldest) oldest = sentAt;

      // De-duplicated on (workspace, owner, provider, externalId), which is
      // why re-running a page is safe and why two colleagues can each import
      // the same thread.
      const existing = await tx.emailMessage.findFirst({
        where: {
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          provider: "outlook",
          externalId,
        },
        select: { id: true },
      });
      if (existing) {
        duplicates += 1;
        continue;
      }

      const association = await associateContact(tx, {
        addresses: candidateAddresses({
          from: message.from?.emailAddress?.address,
          to: (message.toRecipients ?? []).map((r) => r.emailAddress?.address),
          accountEmail: input.accountEmail,
        }),
        workspaceId: input.workspaceId,
        visibleContactWhere: input.visibleContactWhere,
      });
      if (association.contactId) linked += 1;
      else unlinked[association.reason] = (unlinked[association.reason] ?? 0) + 1;

      await tx.emailMessage.create({
        data: {
          workspaceId: input.workspaceId,
          provider: "outlook",
          externalId,
          threadId: message.conversationId ?? externalId,
          subject: message.subject ?? "(no subject)",
          // `bodyPreview` rather than the body: this phase has no use for the
          // full message, and not fetching it is the narrowest thing that
          // works.
          snippet: message.bodyPreview ?? "",
          fromEmail: message.from?.emailAddress?.address ?? "",
          fromName: message.from?.emailAddress?.name ?? null,
          toJson: JSON.stringify(
            (message.toRecipients ?? []).map((r) => ({
              email: r.emailAddress?.address ?? "",
              name: r.emailAddress?.name ?? null,
            })),
          ),
          direction: "inbound",
          sentAt,
          isRead: message.isRead ?? false,
          contactId: association.contactId,
          integrationId: input.integrationId,
          // The three that keep it safe, set at creation and never derived.
          source: "imported",
          ownerUserId: input.ownerUserId,
          visibility: "private",
        },
      });
      imported += 1;
    }

    // ---- Progress, in the same transaction -------------------------------
    const reachedBack =
      oldest && (!state.importedThrough || oldest < state.importedThrough)
        ? oldest
        : state.importedThrough;

    const finished = !input.nextCursor || truncated;

    await tx.integration.update({
      where: { id: input.integrationId },
      data: {
        importedThrough: reachedBack,
        syncState: finished ? "idle" : input.incremental ? "syncing" : "backfilling",
        // A truncated backfill keeps its cursor, so resuming later is a
        // decision rather than a restart.
        syncCursor: input.nextCursor,
        // An incremental pass must not touch either of these. Writing
        // `backfillCompletedAt: null` mid-chain — which the unconditional
        // version did on every page that had a next page — would make a
        // connection whose backfill finished weeks ago look like one that
        // never finished, and `startIncremental` refuses those, so the
        // connection would stop syncing permanently after its first
        // multi-page incremental pass. Nothing caught that, because nothing
        // ran an incremental pass.
        ...(input.incremental
          ? {}
          : {
              backfillTruncated: truncated,
              // Finished when there is no next page, or when the cap stopped
              // us — and in the second case `backfillTruncated` is what stops
              // that reading as "everything is here".
              backfillCompletedAt: finished ? new Date() : null,
            }),
      },
    });

    log.info("integration page imported", {
      integrationId: input.integrationId,
      imported,
      duplicates,
      linked,
      truncated,
    });
    return { imported, duplicates, linked, unlinked, oldest, truncated };
  });
}
