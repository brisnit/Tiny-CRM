"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { assertWithinLimit } from "@/lib/auth/session";
import {
  action, emptyToNull, logActivity, optionalDate, optionalMoney,
  requireWorkspace, revalidateRecord,
} from "@/lib/actions/base";
import { PROJECT_PRIORITY, PROJECT_TYPE } from "@/lib/enums";
import { runAutomations } from "@/lib/automations";

const projectSchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  name: z.string().trim().min(1, "Give the project a name"),
  companyId: emptyToNull,
  statusId: emptyToNull,
  type: z.enum(PROJECT_TYPE.values).nullish(),
  description: emptyToNull,
  priority: z.enum(PROJECT_PRIORITY.values).default("medium"),
  startDate: optionalDate,
  targetDate: optionalDate,
  budgetCents: optionalMoney,
  revenueCents: optionalMoney,
  nextAction: emptyToNull,
  nextActionDueAt: optionalDate,
});

export async function createProject(input: z.input<typeof projectSchema>) {
  return action(async (user) => {
    const data = projectSchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);
    await assertWithinLimit(user, "projects");

    // Fall back to the workspace's default status so a project always has a home.
    const statusId =
      data.statusId ??
      (
        await db.projectStatus.findFirst({
          where: { workspaceId: data.workspaceId, isDefault: true },
          select: { id: true },
        })
      )?.id ??
      null;

    const project = await db.project.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        companyId: data.companyId,
        statusId,
        type: data.type,
        description: data.description,
        priority: data.priority,
        startDate: data.startDate,
        targetDate: data.targetDate,
        budgetCents: data.budgetCents,
        revenueCents: data.revenueCents,
        nextAction: data.nextAction,
        nextActionDueAt: data.nextActionDueAt,
        ownerId: user.id,
        lastActivityAt: new Date(),
      },
    });

    await logActivity({
      workspaceId: data.workspaceId,
      actorId: user.id,
      type: "created",
      title: `Started ${project.name}`,
      projectId: project.id,
      companyId: project.companyId,
    });

    revalidateRecord(["/projects", "/companies"]);
    return { id: project.id, name: project.name };
  });
}

export async function updateProject(id: string, input: Partial<z.input<typeof projectSchema>>) {
  return action(async (user) => {
    const existing = await db.project.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, statusId: true, name: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = projectSchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const statusChanged = Boolean(data.statusId && data.statusId !== existing.statusId);

    const project = await db.project.update({ where: { id }, data });

    if (statusChanged) {
      const status = await db.projectStatus.findUnique({
        where: { id: data.statusId! },
        select: { name: true, key: true, isTerminal: true },
      });
      await db.project.update({
        where: { id },
        data: { completedAt: status?.isTerminal ? new Date() : null, lastActivityAt: new Date() },
      });
      await logActivity({
        workspaceId: existing.workspaceId,
        actorId: user.id,
        type: "project_update",
        title: `Status changed to ${status?.name ?? "Updated"}`,
        meta: { statusKey: status?.key },
        projectId: id,
      });
      await runAutomations({
        workspaceId: existing.workspaceId,
        userId: user.id,
        trigger: "project_status_changed",
        entityType: "project",
        entityId: id,
        context: { statusKey: status?.key ?? "", statusName: status?.name ?? "", projectName: project.name },
      });
    }

    revalidateRecord(["/projects", `/projects/${id}`]);
    return { id: project.id, name: project.name };
  });
}

export async function deleteProject(id: string) {
  return action(async (user) => {
    const existing = await db.project.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId, "manager");
    await db.project.delete({ where: { id } });
    revalidateRecord(["/projects"]);
    return { id };
  });
}

export async function toggleMilestone(id: string) {
  return action(async (user) => {
    const milestone = await db.milestone.findUniqueOrThrow({
      where: { id },
      select: { completedAt: true, name: true, project: { select: { id: true, workspaceId: true } } },
    });
    await requireWorkspace(user.id, milestone.project.workspaceId);

    const done = Boolean(milestone.completedAt);
    await db.milestone.update({ where: { id }, data: { completedAt: done ? null : new Date() } });

    if (!done) {
      await logActivity({
        workspaceId: milestone.project.workspaceId,
        actorId: user.id,
        type: "project_update",
        title: `Milestone complete: ${milestone.name}`,
        projectId: milestone.project.id,
      });
    }

    revalidateRecord([`/projects/${milestone.project.id}`, "/projects"]);
    return { id, done: !done };
  });
}

export async function addMilestone(projectId: string, name: string, dueDate?: string | null) {
  return action(async (user) => {
    const project = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    await requireWorkspace(user.id, project.workspaceId);

    const count = await db.milestone.count({ where: { projectId } });
    const milestone = await db.milestone.create({
      data: { projectId, name: name.trim(), order: count, dueDate: dueDate ? new Date(dueDate) : null },
    });

    revalidateRecord([`/projects/${projectId}`]);
    return { id: milestone.id };
  });
}

export async function setProjectNextAction(id: string, nextAction: string, dueAt?: string | null) {
  return action(async (user) => {
    const existing = await db.project.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId);
    await db.project.update({
      where: { id },
      data: {
        nextAction: nextAction.trim() || null,
        nextActionDueAt: dueAt ? new Date(dueAt) : null,
        lastActivityAt: new Date(),
      },
    });
    revalidateRecord([`/projects/${id}`, "/projects", "/home"]);
    return { id };
  });
}
