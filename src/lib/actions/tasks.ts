"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  assertVersion, audit, emitEvent, guard, logActivity, pickDefined, readWorkspaceId,
  recordAction, revalidateRecord, transaction, workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertRelations } from "@/lib/auth/access";
import { assertWithinLimit } from "@/lib/entitlements";
import { assertConfirmation } from "@/lib/destructive";
import { dispatchSoon } from "@/lib/events";
import { RECURRENCE, TASK_PRIORITY, TASK_STATUS } from "@/lib/enums";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zIdBatch, zOptionalDate, zOptionalId, zOptionalText, zShortText, zVersion,
} from "@/lib/validation/common";

const taskSchema = z.object({
  workspaceId: zId,
  title: zShortText.min(1, "What needs doing?"),
  description: zOptionalText(LIMITS.longText),
  dueAt: zOptionalDate,
  priority: z.enum(TASK_PRIORITY.values).default("medium"),
  status: z.enum(TASK_STATUS.values).default("open"),
  recurrence: z.enum(RECURRENCE.values).default("none"),
  reminderAt: zOptionalDate,
  contactId: zOptionalId,
  companyId: zOptionalId,
  dealId: zOptionalId,
  projectId: zOptionalId,
  opportunityId: zOptionalId,
});

const taskUpdateSchema = taskSchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type TaskInput = z.input<typeof taskSchema>;
type TaskUpdate = z.input<typeof taskUpdateSchema>;

const RELATIONS = ["contactId", "companyId", "dealId", "projectId", "opportunityId"] as const;

const EDITABLE = [
  "title", "description", "dueAt", "priority", "status", "recurrence", "reminderAt",
  ...RELATIONS,
] as const;

export async function createTask(
  input: TaskInput,
): Promise<ActionResult<{ id: string; title: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = taskSchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertWithinLimit(actor, "tasks");
        await assertRelations(workspaceId, relationsOf(data));

        const task = await transaction(async (tx) => {
          const created = await tx.task.create({
            data: {
              workspaceId,
              title: data.title,
              description: data.description ?? null,
              dueAt: data.dueAt ?? null,
              priority: data.priority,
              status: data.status,
              recurrence: data.recurrence,
              reminderAt: data.reminderAt ?? null,
              contactId: data.contactId ?? null,
              companyId: data.companyId ?? null,
              dealId: data.dealId ?? null,
              projectId: data.projectId ?? null,
              opportunityId: data.opportunityId ?? null,
              ownerId: actor.identity.id,
            },
            select: { id: true, title: true },
          });

          await emitEvent(
            {
              workspaceId, name: "task.created", entityType: "task",
              entityId: created.id, actorId: actor.identity.id, payload: { title: created.title },
            },
            tx,
          );

          return created;
        });

        dispatchSoon();
        revalidateRecord(["/tasks", "/projects", "/deals"]);
        return { id: task.id, title: task.title };
      },
    ),
  );
}

export async function updateTask(
  id: string,
  input: TaskUpdate,
): Promise<ActionResult<{ id: string; title: string }>> {
  return guard(() =>
    recordAction("task", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const data = taskUpdateSchema.parse(input);

        const existing = await db.task.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { status: true, title: true },
        });

        await assertRelations(workspaceId, relationsOf(data));

        const becomingDone = data.status === "done" && existing.status !== "done";
        const patch = pickDefined(data, EDITABLE);

        const result = await db.task.updateMany({
          where: {
            id: recordId, workspaceId,
            ...(data.version !== undefined ? { version: data.version } : {}),
          },
          data: {
            ...patch,
            completedAt: becomingDone
              ? new Date()
              : data.status && data.status !== "done"
                ? null
                : undefined,
            version: { increment: 1 },
          },
        });
        assertVersion(result.count, data.version, "task");

        revalidateRecord(["/tasks", "/projects", "/deals", "/home"]);
        return { id: recordId, title: data.title ?? existing.title };
      },
    ),
  );
}

/**
 * Completing a task is the highest-frequency write in the product, so it gets
 * its own narrow action. Recurring tasks respawn here rather than needing a
 * background job, inside the same transaction as the completion.
 */
export async function toggleTask(id: string): Promise<ActionResult<{ id: string; done: boolean }>> {
  return guard(() =>
    recordAction("task", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const task = await db.task.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            id: true, status: true, title: true, dueAt: true, recurrence: true,
            priority: true, description: true, contactId: true, companyId: true, dealId: true,
            projectId: true, opportunityId: true, ownerId: true,
          },
        });

        const done = task.status === "done";

        await transaction(async (tx) => {
          await tx.task.updateMany({
            where: { id: recordId, workspaceId },
            data: {
              status: done ? "open" : "done",
              completedAt: done ? null : new Date(),
              version: { increment: 1 },
            },
          });

          if (done) return;

          await logActivity(
            {
              workspaceId,
              actorId: actor.identity.id,
              type: "task",
              title: `Completed: ${task.title}`,
              taskId: task.id,
              contactId: task.contactId,
              companyId: task.companyId,
              dealId: task.dealId,
              projectId: task.projectId,
              opportunityId: task.opportunityId,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId, name: "task.completed", entityType: "task",
              entityId: task.id, actorId: actor.identity.id, payload: { title: task.title },
            },
            tx,
          );

          const next = task.recurrence !== "none" && task.dueAt
            ? nextOccurrence(task.dueAt, task.recurrence)
            : null;
          if (next) {
            await tx.task.create({
              data: {
                workspaceId,
                title: task.title,
                description: task.description,
                ownerId: task.ownerId,
                dueAt: next,
                priority: task.priority,
                recurrence: task.recurrence,
                contactId: task.contactId,
                companyId: task.companyId,
                dealId: task.dealId,
                projectId: task.projectId,
                opportunityId: task.opportunityId,
              },
            });
          }
        });

        dispatchSoon();
        revalidateRecord(["/tasks", "/projects", "/deals", "/contacts", "/companies"]);
        return { id: recordId, done: !done };
      },
    ),
  );
}

/**
 * Bulk completion.
 *
 * Two independent bounds apply. The batch size is capped by the schema
 * (`zIdBatch`), and the `updateMany` filter carries the workspace id, so ids
 * belonging to another tenant simply match nothing rather than being rejected
 * one by one — which would also confirm which of them exist.
 */
export async function bulkCompleteTasks(
  workspaceId: string,
  ids: string[],
): Promise<ActionResult<{ updated: number }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "record:edit", rateLimit: "bulk" },
      async (actor) => {
        const taskIds = zIdBatch.parse(ids);

        const result = await db.task.updateMany({
          where: {
            id: { in: taskIds },
            workspaceId: actor.workspaceId,
            status: { not: "done" },
          },
          data: { status: "done", completedAt: new Date(), version: { increment: 1 } },
        });

        if (result.count > 0) {
          await audit(actor, {
            workspaceId: actor.workspaceId,
            action: "record.updated",
            entityType: "task",
            summary: `Bulk completed ${result.count} tasks`,
            metadata: { requested: taskIds.length, updated: result.count },
          });
        }

        revalidateRecord(["/tasks", "/home"]);
        return { updated: result.count };
      },
    ),
  );
}

export async function archiveTask(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("task", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        await db.task.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
        revalidateRecord(["/tasks"]);
        return { id: recordId };
      },
    ),
  );
}

export async function deleteTask(
  id: string,
  confirmation?: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("task", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const task = await db.task.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { title: true },
        });
        assertConfirmation(confirmation, task.title);

        await db.task.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId, action: "record.deleted", entityType: "task", entityId: recordId,
          summary: `Permanently deleted task ${task.title}`,
        });

        revalidateRecord(["/tasks"]);
        return { id: recordId };
      },
    ),
  );
}

function relationsOf(data: Partial<Record<(typeof RELATIONS)[number], string | null | undefined>>) {
  return {
    contactId: data.contactId ?? null,
    companyId: data.companyId ?? null,
    dealId: data.dealId ?? null,
    projectId: data.projectId ?? null,
    opportunityId: data.opportunityId ?? null,
  };
}

function nextOccurrence(from: Date, recurrence: string) {
  const next = new Date(from);
  switch (recurrence) {
    case "daily": next.setDate(next.getDate() + 1); break;
    case "weekly": next.setDate(next.getDate() + 7); break;
    case "biweekly": next.setDate(next.getDate() + 14); break;
    case "monthly": next.setMonth(next.getMonth() + 1); break;
    case "quarterly": next.setMonth(next.getMonth() + 3); break;
    default: return null;
  }
  return next;
}
