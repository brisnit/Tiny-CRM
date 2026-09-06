"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { assertWithinLimit } from "@/lib/auth/session";
import {
  action, emptyToNull, logActivity, optionalDate, requireWorkspace, revalidateRecord,
} from "@/lib/actions/base";
import { RECURRENCE, TASK_PRIORITY, TASK_STATUS } from "@/lib/enums";

const taskSchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  title: z.string().trim().min(1, "What needs doing?"),
  description: emptyToNull,
  dueAt: optionalDate,
  priority: z.enum(TASK_PRIORITY.values).default("medium"),
  status: z.enum(TASK_STATUS.values).default("open"),
  recurrence: z.enum(RECURRENCE.values).default("none"),
  reminderAt: optionalDate,
  contactId: emptyToNull,
  companyId: emptyToNull,
  dealId: emptyToNull,
  projectId: emptyToNull,
  opportunityId: emptyToNull,
});

export async function createTask(input: z.input<typeof taskSchema>) {
  return action(async (user) => {
    const data = taskSchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);
    await assertWithinLimit(user, "tasks");

    const task = await db.task.create({
      data: { ...data, ownerId: user.id },
    });

    revalidateRecord(["/tasks", "/projects", "/deals"]);
    return { id: task.id, title: task.title };
  });
}

export async function updateTask(id: string, input: Partial<z.input<typeof taskSchema>>) {
  return action(async (user) => {
    const existing = await db.task.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, status: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = taskSchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const becomingDone = data.status === "done" && existing.status !== "done";

    const task = await db.task.update({
      where: { id },
      data: {
        ...data,
        completedAt: becomingDone ? new Date() : data.status && data.status !== "done" ? null : undefined,
      },
    });

    revalidateRecord(["/tasks", "/projects", "/deals", "/home"]);
    return { id: task.id, title: task.title };
  });
}

/**
 * Completing a task is the highest-frequency write in the product, so it gets
 * its own narrow action: one round-trip, and recurring tasks respawn here
 * rather than needing a background job.
 */
export async function toggleTask(id: string) {
  return action(async (user) => {
    const task = await db.task.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, workspaceId: true, status: true, title: true, dueAt: true, recurrence: true,
        priority: true, description: true, contactId: true, companyId: true, dealId: true,
        projectId: true, opportunityId: true, ownerId: true,
      },
    });
    await requireWorkspace(user.id, task.workspaceId);

    const done = task.status === "done";
    await db.task.update({
      where: { id },
      data: { status: done ? "open" : "done", completedAt: done ? null : new Date() },
    });

    if (!done) {
      await logActivity({
        workspaceId: task.workspaceId,
        actorId: user.id,
        type: "task",
        title: `Completed: ${task.title}`,
        taskId: task.id,
        contactId: task.contactId,
        companyId: task.companyId,
        dealId: task.dealId,
        projectId: task.projectId,
        opportunityId: task.opportunityId,
      });

      if (task.recurrence !== "none" && task.dueAt) {
        await db.task.create({
          data: {
            workspaceId: task.workspaceId,
            title: task.title,
            description: task.description,
            ownerId: task.ownerId,
            dueAt: nextOccurrence(task.dueAt, task.recurrence),
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
    }

    revalidateRecord(["/tasks", "/projects", "/deals", "/contacts", "/companies"]);
    return { id, done: !done };
  });
}

export async function deleteTask(id: string) {
  return action(async (user) => {
    const existing = await db.task.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId);
    await db.task.delete({ where: { id } });
    revalidateRecord(["/tasks"]);
    return { id };
  });
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
