import "server-only";

import { db } from "@/lib/db";
import { withTenantContext, NO_RECORD_READS } from "@/lib/tenant-db";
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
        // Not "system": no such user exists, and this value is spent on a
        // task's ownerId and a notification's userId, both foreign keys to a
        // real User. A job with no actor has no person behind it, and the
        // automation is told so rather than handed a name that cannot resolve.
        userId: job.actorId,
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
    // Captured after the guard: the narrowing above does not survive into the
    // closure below, where `task.ownerId` widens back to string | null.
    const ownerId = task.ownerId;

    // The job runs as whoever queued it; the notification belongs to the task's
    // owner, usually someone else. The Notification policy requires the row's
    // "userId" to match the identity in context, so this insert was refused on
    // PostgreSQL until it ran in the owner's own context. Isolated, so the job's
    // identity is not reused for it.
    await withTenantContext(
      { workspaceIds: [job.workspaceId], userId: ownerId , restrictedWorkspaceIds: NO_RECORD_READS},
      (tx) =>
        tx.notification.create({
          data: {
            userId: ownerId,
            workspaceId: job.workspaceId,
            type: "task_overdue",
            title: `Overdue: ${task.title}`,
            entityType: "task",
            entityId: task.id,
          },
        }),
      { isolated: true },
    );
  });
}

/** The registered names, for the worker's startup banner. */
export function handlerNames(): string[] {
  return [...DOMAIN_EVENTS, "workspace.deletion_due"];
}
