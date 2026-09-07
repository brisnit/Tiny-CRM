import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { env, isProduction } from "@/lib/env";

/**
 * Structured logging with request correlation.
 *
 * Each server request gets an id carried in AsyncLocalStorage, so every log line
 * and every error response for that request shares it. Production emits JSON for
 * a log aggregator; development prints a readable line.
 *
 * The redaction list is not a nicety — CRM logs would otherwise accumulate
 * passwords, tokens and confidential client content.
 */

export type LogContext = {
  requestId: string;
  userId?: string;
  workspaceId?: string;
  route?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function newRequestId(): string {
  // Web Crypto rather than node:crypto — instrumentation.ts is bundled for the
  // Edge runtime as well as Node, and `node:crypto` is unavailable there.
  return globalThis.crypto.randomUUID();
}

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): LogContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Adds detail to the active request's context (user and workspace, once known). */
export function enrichContext(patch: Partial<LogContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /pass(word|hash)?|secret|token|api[-_]?key|authorization|cookie|session|credential|ssn|card/i;

/**
 * Removes sensitive values before anything is written. Applied by key name and
 * by obvious value shapes, and depth-limited so a cyclic or enormous object
 * cannot stall the logger.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`;
    // Bearer tokens and provider keys occasionally appear inside message strings.
    //
    // Webhook URLs need their own rule because the secret *is* the URL: there is
    // no header to strip. A delivery failure logs the error, and a fetch error
    // can carry the URL it was fetching — so without this the alert webhook
    // could reach the logs and the SecurityAlert.deliveryError column through
    // the one path whose job is to report that alerting is broken.
    //
    // Matched on the known webhook hosts rather than "any long URL path", so an
    // ordinary application URL stays readable. Over-redaction is its own
    // failure: logs nobody can read are logs that get switched off.
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED)
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, `Bearer ${REDACTED}`)
      .replace(/https:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/gi, `https://hooks.slack.com/services/${REDACTED}`)
      .replace(/https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi, `https://discord.com/api/webhooks/${REDACTED}`)
      .replace(/https:\/\/[^\s"'<>]*\.webhook\.office\.com\/[^\s"'<>]+/gi, `https://outlook.office.com/webhook/${REDACTED}`)
      // Credentials carried as URL userinfo, in any scheme.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/"']+):([^\s@/"']+)@/gi, `$1$2:${REDACTED}@`);
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[env.logLevel]) return;

  const context = storage.getStore();
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    release: env.release,
    ...(context ? { requestId: context.requestId, userId: context.userId, workspaceId: context.workspaceId, route: context.route } : {}),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };

  const line = isProduction
    ? JSON.stringify(entry)
    : `${level.toUpperCase().padEnd(5)} ${message}${fields ? ` ${JSON.stringify(redact(fields))}` : ""}${context ? ` (${context.requestId.slice(0, 8)})` : ""}`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
