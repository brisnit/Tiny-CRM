import "server-only";

import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import type { Transport } from "@/lib/integrations/oauth-client";

export type { Transport };

/**
 * Reading mail and events from Microsoft Graph, one bounded page at a time.
 *
 * Injectable `transport` so every test here runs against a fake. Nothing in CI
 * reaches Graph; the real provider is exercised only by the canary, by hand.
 */

/** How far back a first import reaches. */
export const BACKFILL_WINDOW_DAYS = 30;
/** Items per request. Graph's maximum for messages is 1000; this is gentler. */
export const PAGE_SIZE = 50;
/**
 * The most pages one backfill will fetch, across all its runs.
 *
 * A cap is the difference between a large mailbox importing slowly and a large
 * mailbox importing forever. When it is hit the import stops and says so —
 * `backfillTruncated` — rather than quietly declaring itself finished, which
 * would leave a customer believing they have correspondence they do not.
 */
export const MAX_BACKFILL_PAGES = 40;

/**
 * The most pages one incremental pass will fetch.
 *
 * Far smaller than the backfill cap because an incremental pass reads only
 * what arrived since the last one. If it ever needs more than this, something
 * has gone wrong — a connection left unsynced for weeks, or a cursor that is
 * not advancing — and the right answer is to stop and say so rather than page
 * through a mailbox under a cap meant for a different job.
 */
export const MAX_INCREMENTAL_PAGES = 10;

/**
 * How far before `lastSyncAt` an incremental pass starts reading.
 *
 * Two clocks are involved — ours and Microsoft's — and a page can be written
 * while later mail is still arriving. Starting exactly at `lastSyncAt` would
 * drop anything that landed in the gap. The overlap re-reads a few minutes of
 * mail that is already imported, which costs one deduplicated page and is the
 * cheapest insurance available: the unique key on
 * (workspace, owner, provider, externalId) makes a re-read a no-op.
 */
export const INCREMENTAL_OVERLAP_MS = 5 * 60_000;

export type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
};

/**
 * How far back and forward a first calendar import reaches.
 *
 * Asymmetric, unlike mail, because a calendar is read in both directions and
 * the product uses them differently: past meetings are history to file against
 * a record, and upcoming ones are what the Calendar page and the prep briefs
 * are for. A month of history is enough context; a month of future is not
 * enough runway, since quarterly planning and renewals are routinely booked
 * further out than that.
 */
export const CALENDAR_DAYS_BACK = 30;
export const CALENDAR_DAYS_FORWARD = 90;

export type GraphEvent = {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  /** Graph returns a wall-clock string plus a named zone, never an offset. */
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  attendees?: {
    emailAddress?: { address?: string; name?: string };
    type?: string;
  }[];
};

export type GraphPage<T> = {
  items: T[];
  /** The next page, or null when this was the last. */
  nextLink: string | null;
  /** Present only on the final page of a delta query. */
  deltaLink: string | null;
};

/**
 * Thrown when a stored cursor is no longer usable.
 *
 * Graph answers `410 Gone` when a delta token has expired or been invalidated.
 * It is not an error to retry: the only recovery is to start a fresh backfill,
 * so it is its own type and the worker handles it rather than the retry
 * machinery seeing a failure and backing off forever.
 */
export class CursorExpiredError extends Error {
  constructor() {
    super("the stored sync cursor is no longer valid");
    this.name = "CursorExpiredError";
  }
}

/** Thrown when Graph asks us to wait. Carries how long it asked for. */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`the provider asked for ${retryAfterSeconds}s before retrying`);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const GRAPH = "https://graph.microsoft.com/v1.0";

/** The first page of a bounded backfill over recent mail. */
export function backfillStartUrl(windowDays = BACKFILL_WINDOW_DAYS): string {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const params = new URLSearchParams({
    // Only the fields that are used. Asking for the full body would pull
    // message content we have no use for in this phase and would widen what a
    // bug could expose.
    $select: "id,conversationId,subject,bodyPreview,receivedDateTime,isRead,from,toRecipients",
    $filter: `receivedDateTime ge ${since}`,
    $orderby: "receivedDateTime desc",
    $top: String(PAGE_SIZE),
  });
  return `${GRAPH}/me/messages?${params.toString()}`;
}

/**
 * Fetches one page.
 *
 * `url` is either our own start URL or a `@odata.nextLink` Graph gave us.
 * Graph's links are absolute and already carry their paging state, which is
 * why a cursor is stored verbatim rather than reconstructed.
 */
export async function fetchPage<T = GraphMessage>(
  url: string,
  accessToken: string,
  transport: Transport = fetch,
): Promise<GraphPage<T>> {
  // A link we did not originate must not be followed. The cursor is stored in
  // our own database, so this is defence against a corrupted or tampered row
  // rather than against a remote attacker — but following an arbitrary URL
  // with a bearer token attached is worth making impossible rather than
  // unlikely.
  if (!url.startsWith(`${GRAPH}/`)) {
    throw new AppError("internal", "That import could not continue.", {
      internal: `refusing to follow a non-Graph URL: ${url.slice(0, 80)}`,
    });
  }

  const response = await transport(url, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });

  if (response.status === 429 || response.status === 503) {
    // Graph sends Retry-After in seconds. Honoured rather than guessed: a
    // fixed backoff against a provider that told us what it wanted is how an
    // integration gets throttled harder.
    const header = response.headers.get("retry-after");
    const seconds = Number.parseInt(header ?? "", 10);
    throw new RateLimitedError(Number.isFinite(seconds) && seconds > 0 ? seconds : 30);
  }
  if (response.status === 410) throw new CursorExpiredError();
  if (response.status === 401) {
    throw new AppError("forbidden", "That connection needs to be reconnected.", {
      internal: "Graph rejected the access token",
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError("internal", "That import could not continue.", {
      // Length rather than content: a Graph error body can quote a message.
      internal: `Graph returned ${response.status} with ${body.length} bytes`,
    });
  }

  const parsed = (await response.json()) as {
    value?: T[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
  };
  const items = Array.isArray(parsed.value) ? parsed.value : [];
  log.debug("graph page fetched", { items: items.length, hasNext: Boolean(parsed["@odata.nextLink"]) });
  return {
    items,
    nextLink: parsed["@odata.nextLink"] ?? null,
    deltaLink: parsed["@odata.deltaLink"] ?? null,
  };
}

/**
 * The first page of an incremental pass: mail that arrived since the last one.
 *
 * ## Why this rather than a delta query
 *
 * Graph does have a delta endpoint, and it was the obvious choice until the
 * documentation was read properly. `message: delta` is **folder-scoped** —
 * `GET /me/mailFolders/{id}/messages/delta` — while the backfill reads
 * `/me/messages`, which is every folder. A delta cursor on the inbox would
 * therefore cover strictly less mail than the import that preceded it, and
 * silently: a customer whose mail is filed by a rule into another folder would
 * see the backfill bring it in and then nothing ever again. Matching the
 * backfill's coverage with delta means one cursor per folder plus folder
 * reconciliation, which is a great deal of machinery to buy change tracking
 * this release does not use — nothing here renders deletions or read-state
 * changes.
 *
 * `$deltatoken=latest`, which would have made a cheap baseline, is documented
 * for Entra resources and (as `token=latest`) for OneDrive and SharePoint. It
 * is **not** among the query parameters the v1.0 `message: delta` reference
 * lists, so it is not relied on here.
 *
 * A windowed re-query reuses the one path the canary has already proven over
 * 320 real messages, covers every folder, and leans on the same unique key to
 * make the overlap free. What it does not do is notice deletions.
 */
/**
 * The first page of a calendar import: the window, expanded.
 *
 * `calendarView` rather than `/me/events` because it "gets the occurrences,
 * exceptions, and single instances of events in a calendar view defined by a
 * time range" — a weekly stand-up arrives as the individual meetings it
 * actually is, which is what filing a meeting against a record requires.
 * `/me/events` returns the recurrence master and leaves expansion to us.
 *
 * Both bounds are sent as `toISOString()`, which carries `Z`. The reference is
 * explicit that the parameters are "interpreted using the timezone offset
 * specified in the value", falling back to UTC when none is given — so an
 * offset-bearing value is unambiguous either way, and this one is.
 */
export function calendarBackfillStartUrl(
  daysBack = CALENDAR_DAYS_BACK,
  daysForward = CALENDAR_DAYS_FORWARD,
): string {
  const params = new URLSearchParams({
    startDateTime: new Date(Date.now() - daysBack * 86_400_000).toISOString(),
    endDateTime: new Date(Date.now() + daysForward * 86_400_000).toISOString(),
    $select: "id,iCalUId,subject,bodyPreview,isAllDay,isCancelled,start,end,location,onlineMeeting,onlineMeetingUrl,organizer,attendees",
    $orderby: "start/dateTime asc",
    $top: String(PAGE_SIZE),
  });
  return `${GRAPH}/me/calendarView?${params.toString()}`;
}

/**
 * Reads a Graph `dateTimeTimeZone` as a real instant.
 *
 * This is the one piece of the calendar import that is easy to get wrong and
 * impossible to notice locally. Graph returns the time as a **wall-clock
 * string with no offset** — `"2026-10-13T14:00:00.0000000"` — alongside a
 * separate `timeZone` name. The reference is explicit that without a
 * `Prefer: outlook.timezone` header "those time values are returned in UTC",
 * and this client sends no such header, so the string is UTC.
 *
 * But `new Date("2026-10-13T14:00:00.0000000")` has no offset to go on, and
 * ECMAScript parses a date-time form without one as **local time**. On a
 * machine in UTC — CI, and the production region when it is on UTC — that is
 * accidentally correct, and every meeting is silently wrong by the offset
 * anywhere else. A developer in California would see every meeting seven or
 * eight hours out while CI stayed green.
 *
 * So the `Z` is appended explicitly rather than inferred. A value that already
 * carries an offset or a `Z` is left exactly as it is.
 */
export function graphInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function incrementalStartUrl(since: Date): string {
  const from = new Date(since.getTime() - INCREMENTAL_OVERLAP_MS).toISOString();
  const params = new URLSearchParams({
    $select: "id,conversationId,subject,bodyPreview,receivedDateTime,isRead,from,toRecipients",
    $filter: `receivedDateTime ge ${from}`,
    $orderby: "receivedDateTime desc",
    $top: String(PAGE_SIZE),
  });
  return `${GRAPH}/me/messages?${params.toString()}`;
}
