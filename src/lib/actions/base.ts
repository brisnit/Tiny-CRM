import "server-only";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ZodError } from "zod";

import { db } from "@/lib/db";
import { AppError, serializeError, toAppError, type SerializedError } from "@/lib/errors";
import { currentRequestId, log, newRequestId, runWithContext } from "@/lib/logger";
import { clientAddress, enforceRateLimit, type PolicyName } from "@/lib/rate-limit";
import { recordAudit, type AuditEntry } from "@/lib/audit";
import { emitEvent } from "@/lib/events";
import {
  requireActor, requireRecordAccess, requireWorkspaceAccess,
  type Actor, type ScopedModel, type WorkspaceActor,
} from "@/lib/auth/access";
import type { Permission } from "@/lib/auth/permissions";
import { PlanLimitError } from "@/lib/plans";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The server-action chokepoint.
 *
 * Every mutation runs through one of the wrappers below. They are the single
 * place that:
 *
 *   - establishes a request id, so an action's logs and its error response share
 *     a correlation key
 *   - authenticates, and optionally authorises a workspace and permission,
 *     *before* the handler body runs
 *   - applies a rate-limit policy
 *   - converts everything thrown — including input-validation failures — into a
 *     safe, categorised result. No stack trace, SQL statement or provider
 *     response ever reaches a browser.
 *
 * Guards therefore cannot be forgotten: they run whether or not the handler
 * remembers to ask for them.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data: T; requestId?: string }
  | SerializedError;

type BaseOptions = {
  /** Rate-limit policy, keyed on the acting user. */
  rateLimit?: PolicyName;
};

type ScopedOptions = BaseOptions & {
  /** The workspace this action targets. Membership is verified before the body runs. */
  workspaceId: string;
  /** Permission required within that workspace. */
  permission?: Permission;
};

/**
 * Wraps an entire action body, including its input parsing, in the error
 * boundary.
 *
 * Parsing that happens before the boundary throws rather than returning a
 * result, which in a server action surfaces as an opaque framework error the
 * client cannot act on and which skips structured logging. Every exported action
 * therefore begins with `guard(async () => { ... })`, and validation runs inside.
 */
export async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  const requestId = currentRequestId() ?? newRequestId();
  return runWithContext({ requestId }, async () => {
    const started = Date.now();
    try {
      return await fn();
    } catch (raw) {
      return failure<T>(raw, requestId, started);
    }
  });
}

/** Runs a handler with an authenticated actor, not bound to a workspace. */
export async function action<T>(
  handler: (actor: Actor) => Promise<T>,
  options: BaseOptions = {},
): Promise<ActionResult<T>> {
  return execute(async () => {
    const actor = await requireActor();
    if (options.rateLimit) await enforceRateLimit(options.rateLimit, actor.identity.id);
    return handler(actor);
  });
}

/**
 * Runs a handler bound to one workspace, with membership and permission proven
 * before the body executes. This is the form nearly every mutation uses.
 */
export async function workspaceAction<T>(
  options: ScopedOptions,
  handler: (actor: WorkspaceActor) => Promise<T>,
): Promise<ActionResult<T>> {
  return execute(async () => {
    const actor = await requireWorkspaceAccess(options.workspaceId, options.permission);
    if (options.rateLimit) await enforceRateLimit(options.rateLimit, actor.identity.id);
    return handler(actor);
  });
}

/**
 * Runs a handler against one record, resolving the workspace from the record
 * itself rather than trusting one supplied by the client.
 */
export async function recordAction<T>(
  model: ScopedModel,
  id: string,
  options: { permission?: Permission; rateLimit?: PolicyName; workspaceId?: string },
  handler: (context: {
    actor: WorkspaceActor;
    workspaceId: string;
    recordId: string;
  }) => Promise<T>,
): Promise<ActionResult<T>> {
  return execute(async () => {
    const { zId } = await import("@/lib/validation/common");
    const recordId = zId.parse(id);
    const { workspaceId, actor } = await requireRecordAccess(model, recordId, {
      permission: options.permission,
      workspaceId: options.workspaceId,
    });
    if (options.rateLimit) await enforceRateLimit(options.rateLimit, actor.identity.id);
    return handler({ actor, workspaceId, recordId });
  });
}

async function execute<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  const requestId = currentRequestId() ?? newRequestId();

  return runWithContext({ requestId }, async () => {
    const started = Date.now();
    try {
      const data = await run();
      log.debug("action ok", { ms: Date.now() - started });
      return { ok: true, data, requestId };
    } catch (raw) {
      return failure<T>(raw, requestId, started);
    }
  });
}

/** Converts anything thrown into a safe, categorised, logged result. */
function failure<T>(raw: unknown, requestId: string, started: number): ActionResult<T> {
  // Plan limits are a product outcome, not a failure — their message is useful.
  if (raw instanceof PlanLimitError) {
    return {
      ok: false,
      error: raw.message,
      category: "plan_limit",
      requestId,
      meta: { limitKey: raw.limitKey, limit: raw.limit, plan: raw.plan },
    };
  }

  // A schema rejection is the expected answer to bad input, not a server fault.
  // Only the first issue is surfaced: enumerating every rejected field of a
  // hostile payload tells the sender more about the schema than it needs.
  if (raw instanceof ZodError) {
    const issue = raw.issues[0];
    log.info("action rejected", { category: "validation", ms: Date.now() - started });
    return {
      ok: false,
      error: issue?.message ?? "Check the values you entered.",
      category: "validation",
      field: issue?.path.length ? issue.path.join(".") : undefined,
      requestId,
    };
  }

  const error = toAppError(raw);

  if (error.category === "internal") {
    // Only internal errors carry detail worth logging. Everything else is the
    // expected outcome of a hostile or careless request.
    log.error("action failed", {
      ms: Date.now() - started,
      error: error.internal instanceof Error ? error.internal.message : String(error.internal),
      stack: error.internal instanceof Error ? error.internal.stack : undefined,
    });
  } else {
    log.info("action rejected", { category: error.category, ms: Date.now() - started });
  }

  return serializeError(error, requestId);
}

/**
 * Reads a workspace id from an unvalidated request body.
 *
 * Used only to choose which workspace the authorization guard should check. It
 * is deliberately forgiving: a missing or malformed value yields an id matching
 * no membership, so the guard refuses with "not found" rather than the action
 * throwing before its boundary exists. The handler then validates the whole
 * input with its real schema.
 */
export function readWorkspaceId(input: unknown): string {
  if (input && typeof input === "object" && "workspaceId" in input) {
    const value = (input as { workspaceId?: unknown }).workspaceId;
    if (typeof value === "string") return value;
  }
  return "";
}

/** Request metadata for audit entries. Never throws. */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    return { ip: clientAddress(h), userAgent: h.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/** Writes an audit entry with actor and request metadata filled in. */
export async function audit(
  actor: Actor | WorkspaceActor,
  entry: Omit<AuditEntry, "actorId" | "actorEmail" | "ip" | "userAgent">,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const meta = await requestMeta();
  await recordAudit(
    {
      ...entry,
      actorId: actor.identity.id,
      actorEmail: actor.identity.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
    tx,
  );
}

/**
 * Runs a multi-step write atomically.
 *
 * Anything touching more than one row — a record plus its activity, an approved
 * AI batch, an archive cascade — belongs here, so a mid-operation failure leaves
 * no half-written state.
 */
export async function transaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(fn, { timeout: 15_000 });
}

/**
 * Records an entry on the activity stream and advances the parent record's
 * recency columns, inside the caller's transaction when there is one.
 */
export async function logActivity(
  input: {
    workspaceId: string;
    actorId: string;
    type: string;
    title: string;
    body?: string | null;
    direction?: string | null;
    durationMin?: number | null;
    meta?: Record<string, unknown> | null;
    occurredAt?: Date;
    contactId?: string | null;
    companyId?: string | null;
    dealId?: string | null;
    projectId?: string | null;
    opportunityId?: string | null;
    taskId?: string | null;
    noteId?: string | null;
  },
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db;
  const occurredAt = input.occurredAt ?? new Date();

  await client.activity.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      type: input.type,
      title: input.title.slice(0, 300),
      body: input.body ?? null,
      direction: input.direction ?? null,
      durationMin: input.durationMin ?? null,
      meta: input.meta ? JSON.stringify(input.meta) : null,
      occurredAt,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      projectId: input.projectId ?? null,
      opportunityId: input.opportunityId ?? null,
      taskId: input.taskId ?? null,
      noteId: input.noteId ?? null,
    },
  });

  // Denormalised recency columns power the "gone quiet" detectors and the
  // scoring engine, so those stay indexed range scans rather than aggregates.
  // Every update is workspace-scoped, so a stale id cannot touch another tenant.
  const touches: Promise<unknown>[] = [];
  if (input.companyId) {
    touches.push(
      client.company.updateMany({
        where: { id: input.companyId, workspaceId: input.workspaceId },
        data: { lastActivityAt: occurredAt },
      }),
    );
  }
  if (input.dealId) {
    touches.push(
      client.deal.updateMany({
        where: { id: input.dealId, workspaceId: input.workspaceId },
        data: { lastActivityAt: occurredAt },
      }),
    );
  }
  if (input.projectId) {
    touches.push(
      client.project.updateMany({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        data: { lastActivityAt: occurredAt },
      }),
    );
  }
  // Only real interactions count as "contacted" — a field edit does not.
  if (input.contactId && ["call", "meeting", "email", "note"].includes(input.type)) {
    touches.push(
      client.contact.updateMany({
        where: { id: input.contactId, workspaceId: input.workspaceId },
        data: { lastContactedAt: occurredAt },
      }),
    );
  }
  await Promise.all(touches);
}

/**
 * Revalidates the routes a write can affect.
 *
 * Cache revalidation is a hint, not part of a write's correctness, and
 * `revalidatePath` throws outside a request context (background jobs, tests). A
 * failure here must never turn a successful write into a reported failure.
 */
export function revalidateRecord(paths: string[]): void {
  try {
    for (const path of paths) revalidatePath(path);
    revalidatePath("/home");
  } catch {
    // Not in a request scope; nothing to revalidate.
  }
}

/**
 * Revalidates a single path, or the whole layout tree.
 *
 * Same contract as `revalidateRecord`: cache invalidation is a hint, and
 * `revalidatePath` throws outside a request scope (background dispatch, tests,
 * scripts). A failure here must never turn a committed write into a reported
 * failure.
 */
export function revalidateLayout(path = "/"): void {
  try {
    revalidatePath(path, "layout");
  } catch {
    // Not in a request scope; nothing to revalidate.
  }
}

export function revalidatePathSafely(path: string): void {
  try {
    revalidatePath(path);
  } catch {
    // Not in a request scope; nothing to revalidate.
  }
}

/**
 * Optimistic concurrency guard.
 *
 * The expected version travels in the WHERE clause, so a concurrent save makes
 * the update match zero rows. This turns that into a clear conflict rather than
 * a silent loss of someone else's edit.
 */
/**
 * Copies only the keys a payload actually carried.
 *
 * Partial forms send the fields they rendered and nothing else. Spreading a
 * parsed payload directly would write `undefined` over columns the user never
 * saw, so every update builds its `data` from an explicit allowlist run through
 * this helper.
 */
export function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function assertVersion(
  matched: number,
  expectedVersion: number | undefined,
  entity: string,
): void {
  if (matched > 0) return;
  if (expectedVersion === undefined) {
    throw new AppError("not_found", `That ${entity} no longer exists.`);
  }
  throw new AppError(
    "conflict",
    `Someone else changed this ${entity} while you were editing. Reload to see their changes.`,
    { meta: { reason: "stale_version" } },
  );
}

export { emitEvent, recordAudit };
export type { Actor, WorkspaceActor };
