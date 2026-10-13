import "server-only";

import { db } from "@/lib/db";
import { assertTenantContext } from "@/lib/documents/gate";
import { log } from "@/lib/logger";
import { associateContact, candidateAddresses } from "@/lib/integrations/sync/associate";
import { GenerationChangedError } from "@/lib/integrations/sync/import";
import {
  graphInstant,
  MAX_BACKFILL_PAGES,
  type GraphEvent,
} from "@/lib/integrations/sync/graph";

/**
 * Writing one page of imported calendar events.
 *
 * The same shape as `importPage` for mail, and for the same reasons — the
 * compare-and-set runs first and takes the row lock, so a disconnect racing an
 * in-flight page either loses or rolls the whole page back. Read the long note
 * at the top of import.ts; none of that reasoning is repeated here.
 *
 * ## Where this deliberately differs from mail
 *
 * A message, once sent, does not change. A meeting does: it moves, it is
 * renamed, people are added, it is cancelled. So where the mail importer skips
 * anything it has already seen, this one **updates** it.
 *
 * That makes the privacy question sharper rather than softer. An update must
 * never be a way for provenance or ownership to drift, so it writes only the
 * presentational fields and never touches `source`, `ownerUserId`,
 * `visibility`, `sharedAt`, `sharedById` or `integrationId`. In particular an
 * event the owner has deliberately shared with the workspace must **stay**
 * shared when its time changes, and an event they have not shared must stay
 * private — so `visibility` is not in the update, in either direction.
 *
 * It also does not re-run contact association on an update. The link may have
 * been corrected by hand, and a re-sync that silently reverted a human's
 * filing would be worse than one that left it alone.
 */

export type ImportEventsInput = {
  integrationId: string;
  workspaceId: string;
  ownerUserId: string;
  accountEmail: string | null;
  generation: number;
  events: GraphEvent[];
  nextCursor: string | null;
  visibleContactWhere: Record<string, unknown>;
  incremental?: boolean;
};

export type ImportEventsResult = {
  imported: number;
  /** Already present, and refreshed in place. */
  updated: number;
  /** Skipped because Graph gave us nothing usable. */
  skipped: number;
  linked: number;
  truncated: boolean;
};

export async function importEventsPage(input: ImportEventsInput): Promise<ImportEventsResult> {
  // Same reasoning as importPage: without a context the CAS below matches no
  // rows under RLS and the caller reads that as "the customer disconnected".
  assertTenantContext("importEventsPage");

  return db.$transaction(async (tx) => {
    const pagesIncrement = input.incremental ? 0 : 1;
    const claimed = await tx.integration.updateMany({
      where: {
        id: input.integrationId,
        syncGeneration: input.generation,
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

    const state = await tx.integration.findUniqueOrThrow({
      where: { id: input.integrationId },
      select: { pagesImported: true },
    });
    const truncated =
      !input.incremental && state.pagesImported >= MAX_BACKFILL_PAGES && Boolean(input.nextCursor);

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let linked = 0;

    for (const event of input.events) {
      const externalId = event.id;
      // Parsed as UTC explicitly — see `graphInstant`. Getting this wrong puts
      // every meeting out by the host's offset and looks correct in CI.
      const startAt = graphInstant(event.start?.dateTime);
      const endAt = graphInstant(event.end?.dateTime);
      if (!externalId || !startAt || !endAt) {
        // An event with no usable time is not a meeting we can place on a
        // calendar. Counted rather than dropped silently.
        skipped += 1;
        continue;
      }

      const existing = await tx.calendarEvent.findFirst({
        where: {
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          provider: "outlook_calendar",
          externalId,
        },
        select: { id: true },
      });

      const presentation = {
        title: event.subject?.trim() || "(no subject)",
        description: event.bodyPreview ?? null,
        location: event.location?.displayName ?? null,
        meetingUrl: event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null,
        startAt,
        endAt,
        allDay: event.isAllDay ?? false,
      };

      if (existing) {
        // Presentation only. Provenance, ownership and visibility are not in
        // this object and must never be.
        await tx.calendarEvent.update({ where: { id: existing.id }, data: presentation });
        updated += 1;
        continue;
      }

      const association = await associateContact(tx, {
        addresses: candidateAddresses({
          from: event.organizer?.emailAddress?.address,
          to: (event.attendees ?? []).map((a) => a.emailAddress?.address),
          accountEmail: input.accountEmail,
        }),
        workspaceId: input.workspaceId,
        visibleContactWhere: input.visibleContactWhere,
      });
      if (association.contactId) linked += 1;

      await tx.calendarEvent.create({
        data: {
          workspaceId: input.workspaceId,
          provider: "outlook_calendar",
          externalId,
          ...presentation,
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

    const finished = !input.nextCursor || truncated;
    await tx.integration.update({
      where: { id: input.integrationId },
      data: {
        syncState: finished ? "idle" : input.incremental ? "syncing" : "backfilling",
        syncCursor: input.nextCursor,
        // An incremental pass leaves the backfill's bookkeeping alone; writing
        // `backfillCompletedAt: null` here would reopen a finished backfill and
        // stop the connection being scheduled ever again. Same trap as mail.
        ...(input.incremental
          ? {}
          : {
              backfillTruncated: truncated,
              backfillCompletedAt: finished ? new Date() : null,
            }),
      },
    });

    log.info("integration events imported", {
      integrationId: input.integrationId,
      imported,
      updated,
      skipped,
      linked,
      truncated,
    });
    return { imported, updated, skipped, linked, truncated };
  });
}
