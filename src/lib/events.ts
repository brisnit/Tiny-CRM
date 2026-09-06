import "server-only";

import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Domain events.
 *
 * Business operations emit events; they do not call the automation engine
 * directly. That inversion is the point: today a dispatcher drains the outbox
 * in-process, but moving to a queue and a worker means replacing the consumer,
 * not editing every write path.
 *
 * Events are written inside the caller's transaction (the outbox pattern), so an
 * event can never describe a change that was rolled back, and a change can never
 * commit without its event.
 */

export const DOMAIN_EVENTS = [
  "contact.created",
  "contact.archived",
  "company.created",
  "deal.created",
  "deal.stage.changed",
  "deal.won",
  "deal.lost",
  "project.created",
  "project.status.changed",
  "task.created",
  "task.completed",
  "task.overdue",
  "opportunity.created",
  "opportunity.deadline.near",
  "note.created",
  "member.added",
  "ai.suggestion.applied",
] as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[number];

export type EmitInput = {
  workspaceId: string;
  name: DomainEventName;
  entityType: string;
  entityId: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Appends an event to the outbox. Pass the transaction client so the event and
 * the change it describes commit together.
 */
export async function emitEvent(
  input: EmitInput,
  tx?: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const client = tx ?? db;
  const event = await client.domainEvent.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      entityType: input.entityType,
      entityId: input.entityId,
      actorId: input.actorId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
    },
    select: { id: true },
  });
  return event;
}

/**
 * Drains pending events and hands them to the automation engine.
 *
 * Written as a worker-shaped function — bounded batch, attempt counter, error
 * capture — so a cron or queue consumer can call it unchanged. It is invoked
 * after a request's transaction commits (best effort) and is safe to run
 * concurrently because each event is claimed by an atomic conditional update.
 */
/**
 * Drains the outbox.
 *
 * Kept as the name the application already calls, but the work now happens in
 * `src/lib/jobs.ts` — with atomic claiming, expiring claims, exponential
 * backoff, a dead-letter state and a per-attempt execution log. This is the
 * seam that made that replaceable without touching a single write path.
 */
export async function dispatchPendingEvents(limit = 25): Promise<{ processed: number; failed: number }> {
  const { runJobs } = await import("@/lib/jobs");
  const { registerJobHandlers } = await import("@/lib/jobs/handlers");
  registerJobHandlers();

  const result = await runJobs(limit);
  return { processed: result.processed, failed: result.failed + result.dead };
}

/** Maps event names onto the automation trigger vocabulary. */
export const TRIGGER_FOR_EVENT: Partial<Record<DomainEventName, string>> = {
  "deal.stage.changed": "deal_stage_changed",
  "project.status.changed": "project_status_changed",
  "contact.created": "contact_created",
  "task.overdue": "task_overdue",
  "opportunity.deadline.near": "opportunity_deadline_near",
};

/**
 * Fire-and-forget dispatch after a write.
 *
 * Deliberately not awaited: automation execution must never make a user's save
 * slower or fail it. This is an optimisation, not the delivery mechanism — a
 * request that dies before draining leaves its events in the outbox, and
 * `npm run worker` (or a cron hitting the same function) is what guarantees they
 * are eventually run. Before the worker existed, this *was* the mechanism, which
 * is why a dead request meant a lost automation.
 */
export function dispatchSoon(): void {
  void dispatchPendingEvents().catch((error) => {
    log.error("background dispatch failed", { error: String(error) });
  });
}
