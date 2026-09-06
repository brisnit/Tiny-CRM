import "server-only";

import { db, currentTenantClient } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-db";
import { currentContext, log, redact } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Application audit log.
 *
 * Append-only by construction: this module exposes a write and a scoped read and
 * nothing else, and no server action offers an update or delete. The database
 * cannot enforce that on its own, so production should additionally grant the
 * application role INSERT and SELECT only on this table — see docs/SECURITY.md.
 *
 * Audit failures are logged rather than thrown. An audit write must never be the
 * reason a user's legitimate action fails, but a silently broken trail is worse
 * than none, so the failure is surfaced at error level.
 */

export type AuditAction =
  | "auth.signed_in" | "auth.sign_in_failed" | "auth.signed_up" | "auth.signed_out"
  | "auth.password_reset_requested" | "auth.password_reset_completed" | "auth.locked_out"
  | "auth.verification_requested" | "auth.email_verified"
  | "auth.session_revoked" | "auth.sessions_revoked"
  | "auth.mfa_enabled" | "auth.mfa_disabled" | "auth.mfa_recovery_regenerated"
  | "member.invited" | "member.role_changed" | "member.removed"
  | "workspace.created" | "workspace.updated" | "workspace.archived" | "workspace.deleted"
  | "record.created" | "record.updated" | "record.archived" | "record.restored" | "record.deleted"
  | "pipeline.changed" | "automation.changed" | "field.changed"
  | "data.exported" | "data.imported"
  | "ai.suggestion_applied" | "ai.suggestion_rejected"
  | "billing.plan_changed"
  | "security.config_changed" | "security.alert_acknowledged"
  | "workspace.deletion_requested" | "workspace.deletion_cancelled"
  | "ai.privacy_changed";

export type AuditEntry = {
  workspaceId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Records an audit entry. Accepts an optional transaction client so the entry
 * commits atomically with the change it describes.
 */
export async function recordAudit(
  entry: AuditEntry,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db;
  const context = currentContext();

  // Audit rows are gated by the same RLS as everything else: a row naming a
  // workspace needs that workspace in context, and a row with no workspace needs
  // `app.user_id` to match its actor. Sign-up, sign-in and password reset all
  // happen before any workspace exists and outside the action wrapper, so they
  // ran with no context at all and every one of those writes was refused —
  // silently, because the failure is swallowed below. That is why AuditLog was
  // empty on the first hosted deployment.
  //
  // Establishing a user-only context here is exactly the claim the row makes:
  // "this happened to this user". It grants no workspace visibility.
  const write = async () => {
    await (tx ?? db).auditLog.create({
      data: {
        workspaceId: entry.workspaceId ?? null,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        summary: entry.summary.slice(0, 500),
        // Metadata passes through the same redaction the logger uses, so an
        // audit row can never become a place secrets accumulate.
        metadata: entry.metadata ? JSON.stringify(redact(entry.metadata)) : null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 300) ?? null,
        requestId: context?.requestId ?? null,
      },
    });
  };

  try {
    // Inside an action the ambient context already covers this row; reuse it so
    // the audit entry commits or rolls back with the change it describes.
    if (tx || currentTenantClient()) {
      await write();
    } else if (entry.workspaceId) {
      await withTenantContext({ workspaceIds: [entry.workspaceId], userId: entry.actorId ?? null }, write);
    } else {
      await withTenantContext({ workspaceIds: [], userId: entry.actorId ?? null }, write);
    }
  } catch (error) {
    // Best-effort by design, and that judgement is now explicit rather than
    // incidental: see docs/RLS.md — "which audit events are best-effort".
    // An audit write must never be the reason a user cannot sign in or a
    // customer cannot save a record. It is logged at error level so a failing
    // audit trail is loud in monitoring even though it is not fatal to the
    // request, and the security-critical events that must not be lost are
    // written inside the caller's transaction via `tx`, where a failure does
    // roll the whole operation back.
    log.error("audit write failed", { action: entry.action, error: String(error) });
  }
}

/** Compact before/after diff for update entries. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: (keyof T)[],
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    if (!(field in after)) continue;
    const from = before[field];
    const to = after[field];
    const same =
      from instanceof Date && to instanceof Date ? from.getTime() === to.getTime() : from === to;
    if (!same) changes[String(field)] = { from, to };
  }
  return changes;
}

/** Reads the audit trail. Callers must already hold `audit:view` for the scope. */
export async function listAuditLog(
  workspaceIds: string[],
  options: { limit?: number; cursor?: string; action?: string; entityId?: string } = {},
) {
  const take = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const rows = await db.auditLog.findMany({
    where: {
      workspaceId: { in: workspaceIds },
      ...(options.action ? { action: options.action } : {}),
      ...(options.entityId ? { entityId: options.entityId } : {}),
    },
    select: {
      id: true, action: true, summary: true, entityType: true, entityId: true,
      actorEmail: true, createdAt: true, metadata: true, ip: true, requestId: true,
      actor: { select: { id: true, name: true } },
      workspace: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  return { entries: rows.slice(0, take), nextCursor: hasMore ? rows[take - 1]!.id : null };
}
