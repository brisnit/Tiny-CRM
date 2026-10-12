import "server-only";

/**
 * Who may see an imported email or calendar event.
 *
 * Imported rows belong to the person whose mailbox they came from. A teammate
 * sharing a workspace is not thereby entitled to read their correspondence —
 * that is the point of the model, and it is the one thing about integrations a
 * customer will not forgive being wrong.
 *
 * ## Two layers, on purpose
 *
 * `prisma/postgres/016_integration_privacy.sql` enforces this in the database
 * with a RESTRICTIVE policy, which is the layer that holds even when
 * application code forgets. This module is the layer that runs *first*, and it
 * exists for two reasons beyond defence in depth:
 *
 *   - SQLite has no row-level security, so the local suite and every
 *     development environment would otherwise show private rows to everyone,
 *     and no test could see the difference.
 *   - A query the database silently narrows still asked for the wrong rows.
 *     Pages paginate; a `take: 50` that RLS then cuts to 3 renders a page that
 *     looks empty for reasons the code cannot explain.
 *
 * ## Seeded data stays workspace-visible
 *
 * Demonstration rows carry `visibility: "workspace"` and behave exactly as they
 * did before this existed. Nothing about the demo changes.
 */

/**
 * Spread into a `where` for EmailMessage or CalendarEvent.
 *
 * Reads as: anything the workspace shares, plus anything private that is mine.
 * Written as an OR over two explicit shapes rather than something cleverer,
 * because the failure mode of being clever here is showing one person's mail to
 * another.
 */
export function visibleToUser(userId: string) {
  return {
    OR: [
      { visibility: { not: "private" } },
      { visibility: "private", ownerUserId: userId },
    ],
  };
}

/**
 * The same question for a row that has already been loaded, for a detail page
 * that fetched a record by id and must decide whether to render it.
 */
export function canSeeImported(
  row: { visibility: string; ownerUserId: string | null },
  userId: string,
): boolean {
  if (row.visibility !== "private") return true;
  return row.ownerUserId === userId;
}
