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
export async function dispatchPendingEvents(limit = 25): Promise<{ processed: number; failed: number }> {
  const { runAutomations } = await import("@/lib/automations");

  const pending = await db.domainEvent.findMany({
    where: { processedAt: null, attempts: { lt: 5 } },
    orderBy: { createdAt: "asc" },
    take: Math.min(limit, 100),
  });

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    // Claim the event: only one worker can move attempts from n to n+1 for a
    // still-unprocessed row, which gives at-least-once without a lock table.
    const claimed = await db.domainEvent.updateMany({
      where: { id: event.id, processedAt: null, attempts: event.attempts },
      data: { attempts: event.attempts + 1 },
    });
    if (claimed.count === 0) continue;

    try {
      await runAutomations({
        workspaceId: event.workspaceId,
        userId: event.actorId ?? "system",
        trigger: TRIGGER_FOR_EVENT[event.name as DomainEventName] ?? event.name,
        entityType: event.entityType as "deal" | "project" | "contact" | "opportunity" | "task",
        entityId: event.entityId,
        context: JSON.parse(event.payload) as Record<string, string | number | boolean | null>,
      });
      await db.domainEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), lastError: null },
      });
      processed++;
    } catch (error) {
      failed++;
      await db.domainEvent.update({
        where: { id: event.id },
        data: { lastError: String(error).slice(0, 500) },
      });
      log.error("event dispatch failed", { event: event.name, id: event.id, error: String(error) });
    }
  }

  return { processed, failed };
}

/** Maps event names onto the automation trigger vocabulary. */
const TRIGGER_FOR_EVENT: Partial<Record<DomainEventName, string>> = {
  "deal.stage.changed": "deal_stage_changed",
  "project.status.changed": "project_status_changed",
  "contact.created": "contact_created",
  "task.overdue": "task_overdue",
  "opportunity.deadline.near": "opportunity_deadline_near",
};

/**
 * Fire-and-forget dispatch after a write.
 *
 * Deliberately not awaited by callers: automation execution must never make a
 * user's save slower or fail it. Unprocessed events remain in the outbox for a
 * scheduled worker to pick up.
 */
export function dispatchSoon(): void {
  void dispatchPendingEvents().catch((error) => {
    log.error("background dispatch failed", { error: String(error) });
  });
}
