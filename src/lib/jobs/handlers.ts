import "server-only";

import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { PermanentJobError, registerHandler } from "@/lib/jobs";
import { DOMAIN_EVENTS, TRIGGER_FOR_EVENT, type DomainEventName } from "@/lib/events";

/**
 * Job handlers.
 *
 * Registered in one place so the set is enumerable: `npm run worker` prints it
 * at startup, and an event with no handler dead-letters immediately rather than
 * retrying five times to discover the same thing.
 *
 * Every handler runs inside the job's own tenant context (see src/lib/jobs.ts),
 * so a handler that forgets to filter by workspace is still confined to one.
 */

let registered = false;

export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;

  // --- Automations --------------------------------------------------------
  //
  // The one consumer that existed before, now with retries, backoff and a
  // dead-letter state behind it.
  for (const event of DOMAIN_EVENTS) {
    registerHandler(event, async (job) => {
      const trigger = TRIGGER_FOR_EVENT[job.name as DomainEventName];
      // Not every domain event drives an automation. Nothing to do is a
      // success, not a failure.
      if (!trigger) return;

      const { runAutomations } = await import("@/lib/automations");
      await runAutomations({
        workspaceId: job.workspaceId,
        userId: job.actorId ?? "system",
        trigger,
        entityType: job.entityType as "deal" | "project" | "contact" | "opportunity" | "task",
        entityId: job.entityId,
        context: job.payload as Record<string, string | number | boolean | null>,
      });
    });
  }

  // --- Delayed workspace deletion -----------------------------------------
  registerHandler("workspace.deletion_due", async (job) => {
    const workspace = await db.workspace.findUnique({
      where: { id: job.workspaceId },
      select: { id: true, name: true, deletionScheduledAt: true },
    });

    if (!workspace) return; // already gone
    if (!workspace.deletionScheduledAt) {
      // Cancelled during the grace period. Not an error.
      log.info("scheduled workspace deletion was cancelled", { workspaceId: job.workspaceId });
      return;
    }
    if (workspace.deletionScheduledAt > new Date()) {
      // Retried with backoff until it is due. The schedule is the source of
      // truth, not the job's availability.
      throw new Error("Deletion is not due yet");
    }

    const { recordAudit } = await import("@/lib/audit");
    // The audit entry outlives the workspace, so it is written first.
    await recordAudit({
      workspaceId: null,
      action: "workspace.deleted",
      entityType: "workspace",
      entityId: workspace.id,
      summary: `Scheduled deletion executed for workspace ${workspace.name}`,
    });

    await db.workspace.delete({ where: { id: workspace.id } });
    log.warn("workspace deleted by scheduled job", { workspaceId: workspace.id });
  });

  // --- Overdue tasks ------------------------------------------------------
  registerHandler("task.overdue", async (job) => {
    const task = await db.task.findFirst({
      where: { id: job.entityId, workspaceId: job.workspaceId },
      select: { id: true, title: true, ownerId: true, status: true },
    });
    if (!task) throw new PermanentJobError("The task no longer exists");
    if (task.status === "done" || !task.ownerId) return;

    await db.notification.create({
      data: {
        userId: task.ownerId,
        workspaceId: job.workspaceId,
        type: "task_overdue",
        title: `Overdue: ${task.title}`,
        entityType: "task",
        entityId: task.id,
      },
    });
  });
}

/** The registered names, for the worker's startup banner. */
export function handlerNames(): string[] {
  return [...DOMAIN_EVENTS, "workspace.deletion_due"];
}
