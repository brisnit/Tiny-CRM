import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/lib/db";
import { AccessError, requireUser, requireWorkspace, type SessionUser } from "@/lib/auth/session";
import { PlanLimitError } from "@/lib/plans";

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code?: "limit" | "access" | "validation" | "unknown"; field?: string };

/**
 * Wraps a server action so every failure reaches the client as a typed result
 * rather than an unhandled server exception. Plan limits and access errors get
 * their own codes so the UI can offer the right next step (upgrade vs. explain).
 */
export async function action<T>(fn: (user: SessionUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireUser();
    const data = await fn(user);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return { ok: false, error: error.message, code: "limit" };
    }
    if (error instanceof AccessError) {
      return { ok: false, error: error.message, code: "access" };
    }
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      return {
        ok: false,
        error: first?.message ?? "That doesn't look right.",
        code: "validation",
        field: first?.path.join("."),
      };
    }
    // Re-throw framework control-flow signals (redirect, notFound).
    if (error && typeof error === "object" && "digest" in error) throw error;
    console.error("[action]", error);
    return { ok: false, error: "Something went wrong. Please try again.", code: "unknown" };
  }
}

/** Records an entry on the shared activity stream and bumps the parent record. */
export async function logActivity(input: {
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
}) {
  const occurredAt = input.occurredAt ?? new Date();

  await db.activity.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      type: input.type,
      title: input.title,
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

  // Keep the denormalised recency columns current — the scoring engine and the
  // "gone quiet" detectors read these instead of aggregating the stream.
  const touches: Promise<unknown>[] = [];
  if (input.companyId) {
    touches.push(db.company.update({ where: { id: input.companyId }, data: { lastActivityAt: occurredAt } }));
  }
  if (input.dealId) {
    touches.push(db.deal.update({ where: { id: input.dealId }, data: { lastActivityAt: occurredAt } }));
  }
  if (input.projectId) {
    touches.push(db.project.update({ where: { id: input.projectId }, data: { lastActivityAt: occurredAt } }));
  }
  // Only real interactions count as "contacted" — a field edit does not.
  if (input.contactId && ["call", "meeting", "email", "note"].includes(input.type)) {
    touches.push(
      db.contact.update({ where: { id: input.contactId }, data: { lastContactedAt: occurredAt } }),
    );
  }
  await Promise.all(touches);
}

/** Revalidates the routes a record write can affect. */
export function revalidateRecord(paths: string[]) {
  for (const path of paths) revalidatePath(path);
  revalidatePath("/home");
}

export { requireWorkspace };

/** Turns "" into null so optional form fields do not store empty strings. */
export const emptyToNull = z
  .string()
  .transform((v) => (v.trim() === "" || v === "__none__" ? null : v.trim()))
  .nullable()
  .optional();

export const optionalDate = z
  .union([z.string(), z.date(), z.null()])
  .optional()
  .transform((v) => {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (v.trim() === "") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  });

export const optionalMoney = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "string" ? Number(v.replace(/[^0-9.-]/g, "")) : v;
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  });

export const optionalInt = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? Math.round(n) : null;
  });
