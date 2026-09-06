/**
 * Structured application errors.
 *
 * Every error that can reach a user carries a category, a safe message and an
 * HTTP status. Anything not modelled here is treated as internal and replaced
 * with a generic message before it leaves the server, so stack traces, SQL,
 * filesystem paths and provider responses never reach a browser.
 */

export type ErrorCategory =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "plan_limit"
  | "internal";

const STATUS: Record<ErrorCategory, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 422,
  conflict: 409,
  rate_limited: 429,
  plan_limit: 402,
  internal: 500,
};

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  /** Extra context safe to show a user (field name, retry delay). */
  readonly meta?: Record<string, unknown>;
  /** Detail for logs only. Never serialised to a client. */
  readonly internal?: unknown;

  constructor(
    category: ErrorCategory,
    message: string,
    options: { meta?: Record<string, unknown>; internal?: unknown } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.category = category;
    this.status = STATUS[category];
    this.meta = options.meta;
    this.internal = options.internal;
  }
}

export const unauthorized = (m = "You need to sign in to do that.") => new AppError("unauthorized", m);
export const forbidden = (m = "You do not have access to that.") => new AppError("forbidden", m);
export const notFound = (m = "That record does not exist.") => new AppError("not_found", m);
export const conflict = (m: string, meta?: Record<string, unknown>) =>
  new AppError("conflict", m, { meta });
export const validation = (m: string, field?: string) =>
  new AppError("validation", m, { meta: field ? { field } : undefined });
export const rateLimited = (m: string, retryAfterSeconds: number) =>
  new AppError("rate_limited", m, { meta: { retryAfterSeconds } });

/**
 * Access failures deliberately return "not found" rather than "forbidden".
 *
 * Telling an attacker that a record exists but belongs to someone else is itself
 * a disclosure — it confirms an id is real and in use. Every cross-tenant probe
 * therefore looks identical to a probe for something that was never there.
 */
export const noSuchRecord = () => new AppError("not_found", "That record does not exist.");

/** Normalises anything thrown into a safe, categorised error. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  // Framework control flow (redirect, notFound) must propagate untouched.
  if (error && typeof error === "object" && "digest" in error) throw error;

  const prisma = error as { code?: string; meta?: { target?: string[] } };
  if (prisma?.code === "P2002") {
    const target = prisma.meta?.target?.join(", ");
    return conflict(
      target ? `That ${target} is already in use.` : "That value is already in use.",
      { field: prisma.meta?.target?.[0] },
    );
  }
  if (prisma?.code === "P2025") return noSuchRecord();
  if (prisma?.code === "P2003") {
    return validation("That references a record that does not exist.");
  }

  return new AppError("internal", "Something went wrong. Please try again.", { internal: error });
}

/** The client-facing shape. Deliberately excludes `internal`. */
export type SerializedError = {
  ok: false;
  error: string;
  category: ErrorCategory;
  field?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
};

export function serializeError(error: AppError, requestId?: string): SerializedError {
  return {
    ok: false,
    error: error.message,
    category: error.category,
    field: typeof error.meta?.field === "string" ? error.meta.field : undefined,
    requestId,
    meta: error.meta,
  };
}
