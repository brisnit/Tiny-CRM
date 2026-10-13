import "server-only";

/**
 * Imported mail and calendar data are excluded from everything that reaches a
 * model provider.
 *
 * ## Why this is a module and not an inline `where` clause
 *
 * Connecting a mailbox is consent to show correspondence inside the CRM. It is
 * not consent to send it to Anthropic. Those are different decisions, and the
 * second one has not been asked for, so Phase 1 does not take it.
 *
 * The exclusion lives here rather than being written out at each call site
 * because it was *already* wrong at two of them: `aiContextFor` pulled email
 * subjects and snippets for `needsReply` threads, and `recommendations` pulled
 * subjects, both straight into a provider prompt. Those predate any real
 * connection, so only seeded demonstration rows ever flowed — but the moment a
 * sync writes a row, that becomes a live disclosure with no code change at all.
 * A named predicate that every call site spreads is the difference between one
 * review and four.
 *
 * ## Why `source` and not `integrationId`
 *
 * `source` is written once at import and never changes afterwards, by
 * anything. `integrationId` is a link, and a link can move.
 *
 * An earlier version of this note justified the choice by saying that
 * disconnecting a mailbox nulls `integrationId`. **It does not.**
 * `onDelete: SetNull` fires when the `Integration` row is *deleted*, and a
 * disconnect keeps the row — only its credentials are destroyed, which is
 * what lets kept correspondence still name the mailbox it came from. The
 * claim was tested by disconnecting a real connection and reading the rows
 * back; the test that had "disconnecting" in its name was deleting the row.
 *
 * The conclusion survives the correction and is stronger without it: keying
 * on an immutable provenance column rather than on a nullable foreign key is
 * right whether or not that key is ever nulled. If `integrationId` ever did
 * become null — by a deletion, a future cleanup, a repair script — a test of
 * `integrationId IS NULL` would silently reclassify imported correspondence
 * as ordinary CRM data and start sending it to a model provider. `source`
 * cannot do that.
 */

/**
 * Spread into any Prisma `where` whose result can reach a model provider.
 *
 * Seeded demonstration rows (`source: "seed"`) are deliberately still
 * included: they are fabricated, they are what the AI features were built and
 * demonstrated against, and excluding them would make the daily brief look
 * broken in every demo workspace while protecting nobody.
 */
export const EXCLUDE_IMPORTED = { source: "seed" } as const;

/**
 * The same thing for the unanswered-thread detector.
 *
 * `needsReply` is set by an AI pass over mail, so an imported message must not
 * become a candidate for it either — otherwise the flag's own computation is
 * the disclosure, before any brief is rendered.
 */
export const IMPORTED_SOURCES = ["imported"] as const;

export function isImported(row: { source?: string | null }): boolean {
  return row.source === "imported";
}
