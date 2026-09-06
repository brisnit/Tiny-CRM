"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { assertWithinLimit } from "@/lib/auth/session";
import {
  action, emptyToNull, logActivity, optionalDate, optionalInt, optionalMoney,
  requireWorkspace, revalidateRecord,
} from "@/lib/actions/base";
import { COMPETITION_LEVEL, OPPORTUNITY_TYPE, STRATEGIC_VALUE, SUBMISSION_STATUS } from "@/lib/enums";

const opportunitySchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  name: z.string().trim().min(1, "Give the opportunity a name"),
  companyId: emptyToNull,
  projectId: emptyToNull,
  pipelineId: emptyToNull,
  stageId: emptyToNull,
  type: z.enum(OPPORTUNITY_TYPE.values).default("rfp"),
  source: emptyToNull,
  solicitationNumber: emptyToNull,
  postedAt: optionalDate,
  questionsDeadlineAt: optionalDate,
  proposalDeadlineAt: optionalDate,
  estimatedValueCents: optionalMoney,
  fitScore: optionalInt,
  strategicValue: z.enum(STRATEGIC_VALUE.values).nullish(),
  competitionLevel: z.enum(COMPETITION_LEVEL.values).nullish(),
  requirements: emptyToNull,
  submissionStatus: z.enum(SUBMISSION_STATUS.values).default("not_started"),
  proposalUrl: emptyToNull,
});

export async function createOpportunity(input: z.input<typeof opportunitySchema>) {
  return action(async (user) => {
    const data = opportunitySchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);
    await assertWithinLimit(user, "opportunities");

    const pipeline =
      data.pipelineId ??
      (
        await db.pipeline.findFirst({
          where: { workspaceId: data.workspaceId, kind: "opportunity" },
          select: { id: true },
          orderBy: { order: "asc" },
        })
      )?.id ??
      null;

    const stage =
      data.stageId ??
      (pipeline
        ? (
            await db.pipelineStage.findFirst({
              where: { pipelineId: pipeline },
              select: { id: true },
              orderBy: { order: "asc" },
            })
          )?.id ?? null
        : null);

    const opportunity = await db.opportunity.create({
      data: {
        ...data,
        pipelineId: pipeline,
        stageId: stage,
        // The proposal deadline is the one that matters for alerts.
        deadlineAt: data.proposalDeadlineAt ?? data.questionsDeadlineAt,
        ownerId: user.id,
      },
    });

    await logActivity({
      workspaceId: data.workspaceId,
      actorId: user.id,
      type: "created",
      title: `Tracking ${opportunity.name}`,
      opportunityId: opportunity.id,
      companyId: opportunity.companyId,
    });

    revalidateRecord(["/opportunities"]);
    return { id: opportunity.id, name: opportunity.name };
  });
}

export async function updateOpportunity(id: string, input: Partial<z.input<typeof opportunitySchema>>) {
  return action(async (user) => {
    const existing = await db.opportunity.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, stageId: true, submissionStatus: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = opportunitySchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const opportunity = await db.opportunity.update({
      where: { id },
      data: {
        ...data,
        deadlineAt: data.proposalDeadlineAt ?? undefined,
      },
    });

    if (data.stageId && data.stageId !== existing.stageId) {
      const stage = await db.pipelineStage.findUnique({
        where: { id: data.stageId },
        select: { name: true },
      });
      await logActivity({
        workspaceId: existing.workspaceId,
        actorId: user.id,
        type: "stage_change",
        title: `Moved to ${stage?.name ?? "a new stage"}`,
        opportunityId: id,
      });
    }

    revalidateRecord(["/opportunities", `/opportunities/${id}`]);
    return { id: opportunity.id, name: opportunity.name };
  });
}

export async function moveOpportunityToStage(id: string, stageId: string) {
  return action(async (user) => {
    const existing = await db.opportunity.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, stageId: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);
    if (existing.stageId === stageId) return { id, unchanged: true };

    await db.opportunity.update({ where: { id }, data: { stageId } });
    const stage = await db.pipelineStage.findUnique({ where: { id: stageId }, select: { name: true } });
    await logActivity({
      workspaceId: existing.workspaceId,
      actorId: user.id,
      type: "stage_change",
      title: `Moved to ${stage?.name ?? "a new stage"}`,
      opportunityId: id,
    });

    revalidateRecord(["/opportunities", `/opportunities/${id}`]);
    return { id, unchanged: false };
  });
}

export async function deleteOpportunity(id: string) {
  return action(async (user) => {
    const existing = await db.opportunity.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    });
    await requireWorkspace(user.id, existing.workspaceId, "manager");
    await db.opportunity.delete({ where: { id } });
    revalidateRecord(["/opportunities"]);
    return { id };
  });
}
