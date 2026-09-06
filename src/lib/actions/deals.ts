"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { assertWithinLimit } from "@/lib/auth/session";
import {
  action, emptyToNull, logActivity, optionalDate, optionalInt, optionalMoney,
  requireWorkspace, revalidateRecord,
} from "@/lib/actions/base";
import { LEAD_SOURCE } from "@/lib/enums";
import { runAutomations } from "@/lib/automations";

const dealSchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  name: z.string().trim().min(1, "Give the deal a name"),
  companyId: emptyToNull,
  primaryContactId: emptyToNull,
  projectId: emptyToNull,
  pipelineId: z.string().min(1, "Choose a pipeline"),
  stageId: z.string().min(1, "Choose a stage"),
  valueCents: optionalMoney,
  probability: optionalInt,
  expectedCloseAt: optionalDate,
  source: z.enum(LEAD_SOURCE.values).nullish(),
  nextStep: emptyToNull,
  lostReason: emptyToNull,
});

export async function createDeal(input: z.input<typeof dealSchema>) {
  return action(async (user) => {
    const data = dealSchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);
    await assertWithinLimit(user, "deals");

    const deal = await db.deal.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        companyId: data.companyId,
        primaryContactId: data.primaryContactId,
        projectId: data.projectId,
        pipelineId: data.pipelineId,
        stageId: data.stageId,
        valueCents: data.valueCents ?? 0,
        probability: data.probability,
        expectedCloseAt: data.expectedCloseAt,
        source: data.source,
        nextStep: data.nextStep,
        ownerId: user.id,
        stageEnteredAt: new Date(),
        lastActivityAt: new Date(),
        contacts: data.primaryContactId
          ? { create: [{ contactId: data.primaryContactId, role: "Primary" }] }
          : undefined,
      },
    });

    await logActivity({
      workspaceId: data.workspaceId,
      actorId: user.id,
      type: "created",
      title: `Created deal ${deal.name}`,
      dealId: deal.id,
      companyId: deal.companyId,
      contactId: deal.primaryContactId,
      projectId: deal.projectId,
    });

    revalidateRecord(["/deals", "/projects", "/companies"]);
    return { id: deal.id, name: deal.name };
  });
}

export async function updateDeal(id: string, input: Partial<z.input<typeof dealSchema>>) {
  return action(async (user) => {
    const existing = await db.deal.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, stageId: true, name: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = dealSchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const stageChanged = Boolean(data.stageId && data.stageId !== existing.stageId);

    const deal = await db.deal.update({
      where: { id },
      data: {
        ...data,
        valueCents: data.valueCents ?? undefined,
        // Entering a new stage restarts the "days in stage" clock that momentum
        // scoring and stall detection both read.
        stageEnteredAt: stageChanged ? new Date() : undefined,
      },
    });

    if (stageChanged) await afterStageChange(user.id, id, existing.stageId, data.stageId!);

    revalidateRecord(["/deals", `/deals/${id}`, "/projects"]);
    return { id: deal.id, name: deal.name };
  });
}

/** Drag-and-drop on the pipeline board lands here. */
export async function moveDealToStage(id: string, stageId: string) {
  return action(async (user) => {
    const existing = await db.deal.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, stageId: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);
    if (existing.stageId === stageId) return { id, unchanged: true };

    await db.deal.update({ where: { id }, data: { stageId, stageEnteredAt: new Date() } });
    await afterStageChange(user.id, id, existing.stageId, stageId);

    revalidateRecord(["/deals", `/deals/${id}`, "/home"]);
    return { id, unchanged: false };
  });
}

async function afterStageChange(userId: string, dealId: string, fromId: string, toId: string) {
  const [deal, from, to] = await Promise.all([
    db.deal.findUniqueOrThrow({
      where: { id: dealId },
      select: {
        id: true, name: true, workspaceId: true, companyId: true, primaryContactId: true,
        projectId: true, valueCents: true,
      },
    }),
    db.pipelineStage.findUnique({ where: { id: fromId }, select: { name: true } }),
    db.pipelineStage.findUniqueOrThrow({ where: { id: toId }, select: { name: true, kind: true, probability: true } }),
  ]);

  // Closing a deal stamps closedAt so win-rate and cycle-time analytics work.
  if (to.kind === "won" || to.kind === "lost") {
    await db.deal.update({ where: { id: dealId }, data: { closedAt: new Date() } });
  } else {
    await db.deal.update({ where: { id: dealId }, data: { closedAt: null } });
  }

  await logActivity({
    workspaceId: deal.workspaceId,
    actorId: userId,
    type: "stage_change",
    title: `Moved to ${to.name}`,
    body: from ? `From ${from.name} to ${to.name}.` : null,
    meta: { from: from?.name ?? null, to: to.name, kind: to.kind },
    dealId: deal.id,
    companyId: deal.companyId,
    contactId: deal.primaryContactId,
    projectId: deal.projectId,
  });

  await runAutomations({
    workspaceId: deal.workspaceId,
    userId,
    trigger: "deal_stage_changed",
    entityType: "deal",
    entityId: deal.id,
    context: { stageName: to.name, stageKind: to.kind, dealName: deal.name },
  });
}

export async function deleteDeal(id: string) {
  return action(async (user) => {
    const existing = await db.deal.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId, "manager");
    await db.deal.delete({ where: { id } });
    revalidateRecord(["/deals"]);
    return { id };
  });
}
