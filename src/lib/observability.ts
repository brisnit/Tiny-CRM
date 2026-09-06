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
  /Invalid `[^`]*` invocation[\s\S]*/,
  // Anything that looks like an email address.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // Long base64/hex runs: tokens, hashes, ids of things we did not choose.
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
];

export function scrubMessage(message: string): string {
  let scrubbed = message.slice(0, 1_000);
  for (const pattern of QUOTED_DATA) {
    scrubbed = scrubbed.replace(pattern, "[redacted]");
  }
  return scrubbed;
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
  return stack
    .split("\n")
    .slice(0, 30)
    .map((line) => line.replace(/\(?\/[^\s)]*?\/(src|scripts|prisma|\.next)\//g, "($1/"))
    .map((line) => line.replace(/file:\/\/\/[^\s)]*/g, "[path]"))
    .join("\n");
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

/** Builds the payload. This allowlist is the control; everything else is transport. */
function buildPayload(error: unknown, context: ErrorContext): Payload {
  const request = currentContext();
  const raw = error instanceof Error ? error : new Error(String(error));

  return {
    type: raw.name,
    message: scrubMessage(raw.message),
    stack: scrubStack(raw.stack),
    requestId: request?.requestId,
    route: context.route,
    operation: context.operation,
    // Ids only. A user id is meaningless outside the database; an email is not.
    userId: context.userId ?? request?.userId ?? undefined,
    workspaceId: context.workspaceId ?? request?.workspaceId ?? undefined,
    release: env.release,
    environment: env.nodeEnv,
    tags: context.tags ? (redact(context.tags) as Record<string, unknown>) : undefined,
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
    try {
      await fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}`,
        },
        body: JSON.stringify({
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
    } catch (sendError) {
      log.error("could not report an exception", { error: String(sendError) });
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
