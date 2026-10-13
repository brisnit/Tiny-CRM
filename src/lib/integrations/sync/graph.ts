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
export async function fetchPage(
  url: string,
  accessToken: string,
  transport: Transport = fetch,
): Promise<GraphPage<GraphMessage>> {
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
    value?: GraphMessage[];
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

/** The delta endpoint, for everything that changed since the last pass. */
export function deltaStartUrl(): string {
  const params = new URLSearchParams({
    $select: "id,conversationId,subject,bodyPreview,receivedDateTime,isRead,from,toRecipients",
  });
  return `${GRAPH}/me/messages/delta?${params.toString()}`;
}
