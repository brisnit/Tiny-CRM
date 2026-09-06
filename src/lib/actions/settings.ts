"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { action, requireWorkspace } from "@/lib/actions/base";
import { assertWithinLimit } from "@/lib/auth/session";
import { createWorkspaceWithDefaults } from "@/lib/actions/auth";
import { PLANS, type PlanId } from "@/lib/plans";

export async function updateProfile(input: { name?: string; jobTitle?: string; timezone?: string }) {
  return action(async (user) => {
    const data = z
      .object({
        name: z.string().trim().min(1).optional(),
        jobTitle: z.string().trim().nullish(),
        timezone: z.string().trim().optional(),
      })
      .parse(input);

    await db.user.update({ where: { id: user.id }, data });
    revalidatePath("/", "layout");
    return { ok: true };
  });
}

export async function createWorkspace(input: { name: string; description?: string; color?: string }) {
  return action(async (user) => {
    await assertWithinLimit(user, "workspaces");
    const workspace = await createWorkspaceWithDefaults(user.id, input);
    revalidatePath("/", "layout");
    return { id: workspace.id, name: workspace.name };
  });
}

export async function updateWorkspace(
  id: string,
  input: { name?: string; description?: string; color?: string },
) {
  return action(async (user) => {
    await requireWorkspace(user.id, id, "admin");
    await db.workspace.update({ where: { id }, data: input });
    revalidatePath("/", "layout");
    return { id };
  });
}

export async function createProjectStatus(
  workspaceId: string,
  input: { name: string; color?: string; isTerminal?: boolean },
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId, "admin");
    const count = await db.projectStatus.count({ where: { workspaceId } });
    const key = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || `status_${count}`;

    const status = await db.projectStatus.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        key,
        color: input.color ?? "#94a3b8",
        order: count,
        isTerminal: input.isTerminal ?? false,
      },
    });
    revalidatePath("/settings/statuses");
    revalidatePath("/projects");
    return { id: status.id };
  });
}

export async function deleteProjectStatus(id: string) {
  return action(async (user) => {
    const status = await db.projectStatus.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, _count: { select: { projects: true } } },
    });
    await requireWorkspace(user.id, status.workspaceId, "admin");
    if (status._count.projects > 0) {
      throw new Error("Move the projects in this status somewhere else first.");
    }
    await db.projectStatus.delete({ where: { id } });
    revalidatePath("/settings/statuses");
    return { id };
  });
}

export async function createPipelineStage(
  pipelineId: string,
  input: { name: string; probability?: number; color?: string; kind?: string },
) {
  return action(async (user) => {
    const pipeline = await db.pipeline.findUniqueOrThrow({
      where: { id: pipelineId },
      select: { workspaceId: true },
    });
    await requireWorkspace(user.id, pipeline.workspaceId, "admin");

    const count = await db.pipelineStage.count({ where: { pipelineId } });
    const stage = await db.pipelineStage.create({
      data: {
        pipelineId,
        name: input.name.trim(),
        order: count,
        probability: input.probability ?? 50,
        color: input.color ?? "#94a3b8",
        kind: input.kind ?? "open",
      },
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/deals");
    return { id: stage.id };
  });
}

export async function createPipeline(
  workspaceId: string,
  input: { name: string; kind: "deal" | "opportunity"; stages: string[] },
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId, "admin");
    const count = await db.pipeline.count({ where: { workspaceId } });

    const pipeline = await db.pipeline.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        kind: input.kind,
        order: count,
        stages: {
          create: input.stages.map((name, i) => ({
            name: name.trim(),
            order: i,
            // Spread base win rates evenly, with the last stage as the win.
            probability: Math.round(((i + 1) / input.stages.length) * 100),
            kind: i === input.stages.length - 1 ? "won" : "open",
            color: i === input.stages.length - 1 ? "#068C28" : "#94a3b8",
          })),
        },
      },
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/deals");
    return { id: pipeline.id };
  });
}

export async function createCustomField(
  workspaceId: string,
  input: { entityType: string; label: string; type: string; options?: string[] },
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId, "admin");
    await assertWithinLimit(user, "customFields");

    const key = input.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
    const count = await db.customFieldDef.count({ where: { workspaceId, entityType: input.entityType } });

    const field = await db.customFieldDef.create({
      data: {
        workspaceId,
        entityType: input.entityType,
        key,
        label: input.label.trim(),
        type: input.type,
        options: input.options?.length ? JSON.stringify(input.options) : null,
        order: count,
      },
    });
    revalidatePath("/settings/fields");
    return { id: field.id };
  });
}

export async function deleteCustomField(id: string) {
  return action(async (user) => {
    const field = await db.customFieldDef.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    });
    await requireWorkspace(user.id, field.workspaceId, "admin");
    await db.customFieldDef.delete({ where: { id } });
    revalidatePath("/settings/fields");
    return { id };
  });
}

export async function createTag(workspaceId: string, name: string, color?: string) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId);
    const tag = await db.tag.upsert({
      where: { workspaceId_name: { workspaceId, name: name.trim() } },
      create: { workspaceId, name: name.trim(), color: color ?? "#068C28" },
      update: { color: color ?? undefined },
    });
    revalidatePath("/settings/tags");
    return { id: tag.id };
  });
}

export async function deleteTag(id: string) {
  return action(async (user) => {
    const tag = await db.tag.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, tag.workspaceId, "admin");
    await db.tag.delete({ where: { id } });
    revalidatePath("/settings/tags");
    return { id };
  });
}

/**
 * Plan changes.
 *
 * There is no payment processor wired up, so this records the plan directly and
 * says so in the UI. The seam is deliberate: `src/lib/billing` would own a
 * checkout session and a webhook that calls exactly this function, and nothing
 * else in the app would change.
 */
export async function changePlan(plan: PlanId) {
  return action(async (user) => {
    if (!PLANS[plan]) throw new Error("Unknown plan.");

    await db.user.update({
      where: { id: user.id },
      data: {
        plan,
        planStatus: "active",
        planRenewsAt:
          plan === "pro" ? new Date(Date.now() + 30 * 86_400_000) : null,
      },
    });
    revalidatePath("/", "layout");
    return { plan };
  });
}
