import "server-only";

import { env, isProduction } from "@/lib/env";
import { currentContext, log, redact } from "@/lib/logger";

/**
 * Observability.
 *
 * Provider-independent by construction. Nothing in the application imports
 * Sentry, an OpenTelemetry SDK or a log-drain client; they all call
 * `captureError` and `recordSpan` here, and this module decides where that goes.
 * Adding a provider is one adapter in this file.
 *
 * ---------------------------------------------------------------------------
 * The rule that shapes this file
 * ---------------------------------------------------------------------------
 *
 * **An error report is a place customer data escapes to a third party.** Sentry
 * and its equivalents capture local variables, request bodies and breadcrumbs by
 * default, which for this application means contact details, deal values and the
 * text of private notes — leaving the deployment, into a system with different
 * access control, retention and jurisdiction.
 *
 * So every payload assembled here is built from an explicit allowlist:
 *
 *   the error's type and message, a stack trace, the request id, the route, and
 *   the ids of the user and workspace.
 *
 * Never: CRM field values, note or document contents, AI prompts or completions,
 * passwords, tokens, API keys, or request bodies. The message itself is scrubbed
 * as well, because an ORM error will happily quote the row that failed.
 */

export type ErrorContext = {
  route?: string;
  /** A short, non-identifying label: "deal.stage.changed", "export.csv". */
  operation?: string;
  /** Ids only. Never names, emails or content. */
  userId?: string | null;
  workspaceId?: string | null;
  /** Small scalar facts. Passed through the same redaction as the audit log. */
  tags?: Record<string, string | number | boolean | null>;
};

export type ObservabilityAdapter = {
  readonly kind: string;
  captureError(error: unknown, context: ErrorContext): Promise<void>;
  recordSpan(span: Span): Promise<void>;
};

export type Span = {
  name: string;
  durationMs: number;
  ok: boolean;
  attributes?: Record<string, string | number | boolean>;
};

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a message is quoting data rather than describing a
 * fault. Matched conservatively: a false positive costs a slightly less specific
 * error report, a false negative sends a customer's data to a third party.
 */
const QUOTED_DATA = [
  // Prisma echoes the offending row: `Unique constraint failed on the fields: (`email`)`
  //
  // Bounded at the first stack frame. Unbounded (`[\s\S]*`) it consumed the
  // whole string — which was invisible while this only ran on the message, and
  // erased every frame the moment the same rule was applied to the stack. An
  // error report with no frames is not a safer report, it is a useless one.
  /Invalid `[^`]*` invocation[\s\S]*?(?=\n\s+at |$)/,
  // Anything that looks like an email address.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // Long base64/hex runs: tokens, hashes, ids of things we did not choose.
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
];

/**
 * Removes everything sensitive from a block of text.
 *
 * Shared by the message and the stack, because they are the same text: a Node
 * stack *begins with the error message*. Scrubbing only the message left the
 * full original in `logentry.formatted` one field further down the payload —
 * database password, webhook URL, API key, session token and CRM note text all
 * included. Found by intercepting the outbound request and reading the bytes.
 */
function stripSensitive(text: string): string {
  let out = text;
  for (const pattern of QUOTED_DATA) {
    out = out.replace(pattern, "[redacted]");
  }
  // The logger's rules as well: credentials carried in a URL rather than in a
  // recognisable key/value pair.
  return String(redact(out));
}

export function scrubMessage(message: string): string {
  return stripSensitive(message.slice(0, 1_000));
}

/**
 * Trims a stack to frames inside the application.
 *
 * Node's stack frames carry absolute filesystem paths, which disclose the
 * deployment layout and occasionally a username. Only the repository-relative
 * part is kept.
 */
export function scrubStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const paths = stack
    .split("\n")
    .slice(0, 30)
    .map((line) => line.replace(/\(?\/[^\s)]*?\/(src|scripts|prisma|\.next)\//g, "($1/"))
    .map((line) => line.replace(/file:\/\/\/[^\s)]*/g, "[path]"))
    .join("\n");
  // The frames are now safe; the first line is still the raw message.
  return stripSensitive(paths);
}

/**
 * Keeps the path, discards the query string.
 *
 * Next hands `onRequestError` a path with the query attached — its own docs
 * give `/blog?name=foo` as the example — and that value became Sentry's
 * transaction name. For this application that meant `/api/search?q=...`, so a
 * user's search term, which is the name of a contact or company they were
 * looking for, left the deployment every time that route threw. `?q=%` already
 * does throw.
 *
 * The path itself is kept: it is what makes the report navigable, and its
 * dynamic segments are ids, which the allowlist already permits.
 */
export function scrubRoute(route: string | undefined): string | undefined {
  if (!route) return undefined;
  return route.split(/[?#]/)[0]!.slice(0, 200);
}

type Payload = {
  type: string;
  message: string;
  stack?: string;
  requestId?: string;
  route?: string;
  operation?: string;
  userId?: string;
  workspaceId?: string;
  release: string;
  environment: string;
  tags?: Record<string, unknown>;
};

/**
 * The shape of an identifier: a cuid, a uuid, a request id, an enum, a dotted
 * operation name, an HTTP status. Deliberately excludes whitespace and `@`.
 */
const IDENTIFIER = /^[A-Za-z0-9_.:\/-]{1,64}$/;

/**
 * Tags are identifiers, not content — enforced by shape rather than trusted.
 *
 * Scrubbing cannot work here. `redact` matches key names, so a tag called
 * `note` is invisible to it, and no pattern recognises ordinary English: the
 * note "client is unhappy about pricing" contains no token, no URL and no
 * address, so every content rule passed it through untouched and it was sent
 * to Sentry in full.
 *
 * Deciding whether a string is customer data is not something a regular
 * expression can do. What *is* decidable is whether it looks like an
 * identifier, which is all a tag is ever allowed to be. Prose contains spaces;
 * cuids, uuids, enums, request ids and operation names do not. So anything
 * that is not identifier-shaped is dropped and replaced by its length, which
 * still says "a value was here, and how big" without disclosing it.
 *
 * A caller who loses a legitimate tag gets a slightly less specific report. The
 * inverse mistake sends a customer's private note to a third party.
 */
function scrubTags(tags: Record<string, unknown>): Record<string, unknown> {
  const safe = redact(tags) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(safe)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const scrubbed = stripSensitive(value);
    out[key] = IDENTIFIER.test(scrubbed) ? scrubbed : `[dropped: ${value.length} chars]`;
  }
  return out;
}

/** Builds the payload. This allowlist is the control; everything else is transport. */
function buildPayload(error: unknown, context: ErrorContext): Payload {
  const request = currentContext();
  const raw = error instanceof Error ? error : new Error(String(error));

  return {
    type: raw.name,
    message: scrubMessage(raw.message),
    stack: scrubStack(raw.stack),
    requestId: request?.requestId,
    route: scrubRoute(context.route),
    operation: context.operation,
    // Ids only. A user id is meaningless outside the database; an email is not.
    userId: context.userId ?? request?.userId ?? undefined,
    workspaceId: context.workspaceId ?? request?.workspaceId ?? undefined,
    release: env.release,
    environment: env.nodeEnv,
    // Key-based redaction *and* content scrubbing, with a hard length cap.
    // `redact` catches `password`/`authorization`/`cookie` by name; it cannot
    // know that a key called `note` holds a customer's note. Tags are meant to
    // be identifiers and enums — the cap makes a value that is actually prose
    // useless to leak rather than merely unlikely to.
    tags: context.tags ? scrubTags(context.tags) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Always present. Structured logs are the floor, not an optional extra. */
class LogAdapter implements ObservabilityAdapter {
  readonly kind = "log";

  async captureError(error: unknown, context: ErrorContext): Promise<void> {
    const payload = buildPayload(error, context);
    log.error("captured exception", {
      type: payload.type,
      message: payload.message,
      route: payload.route,
      operation: payload.operation,
      stack: payload.stack,
    });
  }

  async recordSpan(span: Span): Promise<void> {
    if (span.durationMs < 500) return; // only the slow ones are worth a line
    log.warn("slow operation", { span: span.name, ms: Math.round(span.durationMs), ok: span.ok });
  }
}

/**
 * Sentry over its Store endpoint, without the SDK.
 *
 * The SDK's value is automatic instrumentation — breadcrumbs, request bodies,
 * local variables — which is exactly what must not happen here. Posting the
 * envelope directly keeps the payload to the allowlist above.
 */
class SentryAdapter implements ObservabilityAdapter {
  readonly kind = "sentry";

  constructor(private readonly dsn: string) {}

  private endpoint(): { url: string; key: string } | null {
    // https://<key>@<host>/<projectId>
    const match = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(this.dsn);
    if (!match) return null;
    return { url: `https://${match[2]}/api/${match[3]}/store/`, key: match[1]! };
  }

  async captureError(error: unknown, context: ErrorContext): Promise<void> {
    const target = this.endpoint();
    if (!target) {
      log.error("SENTRY_DSN is malformed; falling back to logs");
      return;
    }

    const payload = buildPayload(error, context);
    // Sentry accepts a client-supplied event id and uses it as the event's own.
    // Choosing it here means a log line can name the exact event without the
    // adapter parsing a response body, which it deliberately does not read.
    // Without it an accepted report is unfindable: the dashboard has an event,
    // the logs have a request, and nothing connects the two.
    const eventId = globalThis.crypto.randomUUID().replace(/-/g, "");
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}`,
        },
        body: JSON.stringify({
          event_id: eventId,
          timestamp: new Date().toISOString(),
          platform: "node",
          level: "error",
          release: payload.release,
          environment: payload.environment,
          transaction: payload.route ?? payload.operation,
          // `user` carries an id and nothing else — no email, no username, no
          // IP address, all of which Sentry would happily accept.
          user: payload.userId ? { id: payload.userId } : undefined,
          tags: {
            requestId: payload.requestId,
            workspaceId: payload.workspaceId,
            operation: payload.operation,
          },
          extra: payload.tags,
          exception: {
            values: [{ type: payload.type, value: payload.message, stacktrace: undefined }],
          },
          // The stack goes in a plain field rather than a parsed stacktrace, so
          // Sentry does not attempt to fetch source or attach local scope.
          logentry: { formatted: payload.stack },
        }),
        signal: AbortSignal.timeout(3_000),
      });

      // fetch does not throw on 4xx or 5xx, so without this a rejected event —
      // rate limited, payload too large, bad key, endpoint retired — returned
      // normally and the adapter carried on as though the error had been
      // reported. An empty dashboard would then mean "nothing broke" and
      // "reporting is broken" indistinguishably, which is the worst way for
      // observability to fail. The response body is deliberately not read: it
      // echoes nothing useful and could carry the payload back.
      if (!response.ok) {
        log.error("could not report an exception", {
          status: response.status,
          eventId,
          operation: payload.operation,
        });
        return;
      }

      // The correlation record. `requestId` is already a tag on the event, so
      // this line joins a request in these logs to an issue in the tracker in
      // both directions.
      log.info("exception reported", {
        eventId,
        requestId: payload.requestId,
        operation: payload.operation,
      });
    } catch (sendError) {
      log.error("could not report an exception", { eventId, error: String(sendError) });
    }
  }

  async recordSpan(): Promise<void> {
    // Tracing is out of scope for this adapter; the OTLP one carries spans.
  }
}

/**
 * OpenTelemetry over OTLP/HTTP.
 *
 * Spans only. Traces carry timing and identifiers, and this adapter deliberately
 * never attaches an event body — a span attribute is as capable of leaking a
 * note's text as an error report is.
 */
class OtelAdapter implements ObservabilityAdapter {
  readonly kind = "otel";

  constructor(private readonly endpoint: string) {}

  async captureError(error: unknown, context: ErrorContext): Promise<void> {
    await new LogAdapter().captureError(error, context);
  }

  async recordSpan(span: Span): Promise<void> {
    const request = currentContext();
    try {
      await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: "service.name", value: { stringValue: "tiny-crm" } },
                  { key: "service.version", value: { stringValue: env.release } },
                  { key: "deployment.environment", value: { stringValue: env.nodeEnv } },
                ],
              },
              scopeSpans: [
                {
                  spans: [
                    {
                      name: span.name,
                      startTimeUnixNano: String((Date.now() - span.durationMs) * 1e6),
                      endTimeUnixNano: String(Date.now() * 1e6),
                      status: { code: span.ok ? 1 : 2 },
                      attributes: Object.entries({
                        "request.id": request?.requestId,
                        "workspace.id": request?.workspaceId,
                        ...span.attributes,
                      })
                        .filter(([, value]) => value !== undefined)
                        .map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
                    },
                  ],
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // Losing a span must never affect a request.
    }
  }
}

/** A generic structured-log drain, for Vercel, Datadog, Better Stack and similar. */
class DrainAdapter implements ObservabilityAdapter {
  readonly kind = "drain";

  constructor(private readonly url: string) {}

  async captureError(error: unknown, context: ErrorContext): Promise<void> {
    const payload = buildPayload(error, context);
    await new LogAdapter().captureError(error, context);
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "error", ...payload }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // The log line above is the durable record; the drain is best-effort.
    }
  }

  async recordSpan(span: Span): Promise<void> {
    await new LogAdapter().recordSpan(span);
  }
}

// ---------------------------------------------------------------------------

function selectAdapter(): ObservabilityAdapter {
  if (env.sentryDsn) return new SentryAdapter(env.sentryDsn);
  if (env.otelEndpoint) return new OtelAdapter(env.otelEndpoint);
  if (env.logDrainUrl) return new DrainAdapter(env.logDrainUrl);
  return new LogAdapter();
}

const globalForObservability = globalThis as unknown as {
  observability?: ObservabilityAdapter;
};
const adapter: ObservabilityAdapter = (globalForObservability.observability ??= selectAdapter());

/**
 * Reports an unhandled failure. Never throws — a reporting failure must not
 * become the error.
 */
export async function captureError(error: unknown, context: ErrorContext = {}): Promise<void> {
  try {
    await adapter.captureError(error, context);
  } catch (reportingError) {
    log.error("observability adapter threw", { error: String(reportingError) });
  }
}

/** Records a completed operation. Called for the ones worth watching. */
export async function recordSpan(span: Span): Promise<void> {
  try {
    await adapter.recordSpan(span);
  } catch {
    // Never
  }
}

/**
 * Times an operation and reports it, including when it throws.
 *
 * The categories the previous report listed as needing capture — failed server
 * actions, slow database requests, failed AI requests, failed background jobs,
 * webhook failures — all route through this or `captureError`.
 */
export async function observe<T>(
  name: string,
  fn: () => Promise<T>,
  context: ErrorContext = {},
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    void recordSpan({ name, durationMs: Date.now() - started, ok: true });
    return result;
  } catch (error) {
    void recordSpan({ name, durationMs: Date.now() - started, ok: false });
    void captureError(error, { ...context, operation: context.operation ?? name });
    throw error;
  }
}

export function observabilityBackend(): { kind: string; configured: boolean } {
  return { kind: adapter.kind, configured: adapter.kind !== "log" };
}

/** Startup summary, so an unconfigured deployment says so once rather than never. */
export function reportObservabilityStatus(): void {
  const backend = observabilityBackend();
  if (backend.configured) {
    log.info("observability configured", { adapter: backend.kind });
  } else if (isProduction) {
    log.warn(
      "no error tracker configured — exceptions go to logs only. " +
        "Set SENTRY_DSN, OTEL_EXPORTER_OTLP_ENDPOINT or LOG_DRAIN_URL.",
    );
  }
}
