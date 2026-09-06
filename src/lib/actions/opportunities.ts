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
import { diffFields } from "@/lib/audit";
import {
  COMPETITION_LEVEL, OPPORTUNITY_TYPE, STRATEGIC_VALUE, SUBMISSION_STATUS,
} from "@/lib/enums";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zOptionalDate, zOptionalId, zOptionalInt, zOptionalMoney, zOptionalText,
  zOptionalUrl, zShortText, zVersion,
} from "@/lib/validation/common";

const opportunitySchema = z.object({
  workspaceId: zId,
  name: zShortText.min(1, "Give the opportunity a name"),
  companyId: zOptionalId,
  projectId: zOptionalId,
  pipelineId: zOptionalId,
  stageId: zOptionalId,
  type: z.enum(OPPORTUNITY_TYPE.values).default("rfp"),
  source: zOptionalText(LIMITS.shortText),
  solicitationNumber: zOptionalText(LIMITS.shortText),
  postedAt: zOptionalDate,
  questionsDeadlineAt: zOptionalDate,
  proposalDeadlineAt: zOptionalDate,
  estimatedValueCents: zOptionalMoney,
  fitScore: zOptionalInt(0, 100),
  strategicValue: z.enum(STRATEGIC_VALUE.values).nullish(),
  competitionLevel: z.enum(COMPETITION_LEVEL.values).nullish(),
  requirements: zOptionalText(LIMITS.longText),
  submissionStatus: z.enum(SUBMISSION_STATUS.values).default("not_started"),
  proposalUrl: zOptionalUrl,
});

const opportunityUpdateSchema = opportunitySchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type OpportunityInput = z.input<typeof opportunitySchema>;
type OpportunityUpdate = z.input<typeof opportunityUpdateSchema>;

const EDITABLE = [
  "name", "companyId", "projectId", "pipelineId", "stageId", "type", "source",
  "solicitationNumber", "postedAt", "questionsDeadlineAt", "proposalDeadlineAt",
  "estimatedValueCents", "fitScore", "strategicValue", "competitionLevel",
  "requirements", "submissionStatus", "proposalUrl",
] as const;

export async function createOpportunity(
  input: OpportunityInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = opportunitySchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertWithinLimit(actor, "opportunities");
        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          projectId: data.projectId ?? null,
          pipelineId: data.pipelineId ?? null,
          stageId: data.stageId ?? null,
        });

        // Defaults are resolved within the workspace, so an opportunity never
        // lands on a pipeline the caller could not have chosen explicitly.
        const pipelineId =
          data.pipelineId ??
          (
            await db.pipeline.findFirst({
              where: { workspaceId, kind: "opportunity" },
              select: { id: true },
              orderBy: { order: "asc" },
            })
          )?.id ??
          null;

        const stageId =
          data.stageId ??
          (pipelineId
            ? (
                await db.pipelineStage.findFirst({
                  where: { pipelineId, pipeline: { workspaceId } },
                  select: { id: true },
                  orderBy: { order: "asc" },
                })
              )?.id ?? null
            : null);

        const opportunity = await transaction(async (tx) => {
          const created = await tx.opportunity.create({
            data: {
              workspaceId,
              name: data.name,
              companyId: data.companyId ?? null,
              projectId: data.projectId ?? null,
              pipelineId,
              stageId,
              type: data.type,
              source: data.source ?? null,
              solicitationNumber: data.solicitationNumber ?? null,
              postedAt: data.postedAt ?? null,
              questionsDeadlineAt: data.questionsDeadlineAt ?? null,
              proposalDeadlineAt: data.proposalDeadlineAt ?? null,
              // The proposal deadline is the one that matters for alerts.
              deadlineAt: data.proposalDeadlineAt ?? data.questionsDeadlineAt ?? null,
              estimatedValueCents: data.estimatedValueCents ?? null,
              fitScore: data.fitScore ?? null,
              strategicValue: data.strategicValue ?? null,
              competitionLevel: data.competitionLevel ?? null,
              requirements: data.requirements ?? null,
              submissionStatus: data.submissionStatus,
              proposalUrl: data.proposalUrl ?? null,
              ownerId: actor.identity.id,
            },
            select: { id: true, name: true, companyId: true },
          });

          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "created",
              title: `Tracking ${created.name}`,
              opportunityId: created.id, companyId: created.companyId,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId, name: "opportunity.created", entityType: "opportunity",
              entityId: created.id, actorId: actor.identity.id, payload: { name: created.name },
            },
            tx,
          );

          return created;
        });

        await audit(actor, {
          workspaceId, action: "record.created", entityType: "opportunity",
          entityId: opportunity.id, summary: `Created opportunity ${opportunity.name}`,
        });

        revalidateRecord(["/opportunities"]);
        return { id: opportunity.id, name: opportunity.name };
      },
    ),
  );
}

export async function updateOpportunity(
  id: string,
  input: OpportunityUpdate,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = opportunityUpdateSchema.parse(input);

        const existing = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            name: true, stageId: true, pipelineId: true, submissionStatus: true,
            companyId: true, estimatedValueCents: true, proposalDeadlineAt: true,
          },
        });

        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          projectId: data.projectId ?? null,
          pipelineId: data.pipelineId ?? (data.stageId ? existing.pipelineId : null),
          stageId: data.stageId ?? null,
        });

        const stageChanged = Boolean(data.stageId && data.stageId !== existing.stageId);
        const patch = pickDefined(data, EDITABLE);

        const result = await db.opportunity.updateMany({
          where: {
            id: recordId, workspaceId,
            ...(data.version !== undefined ? { version: data.version } : {}),
          },
          data: {
            ...patch,
            ...(data.proposalDeadlineAt !== undefined
              ? { deadlineAt: data.proposalDeadlineAt ?? null }
              : {}),
            version: { increment: 1 },
          },
        });
        assertVersion(result.count, data.version, "opportunity");

        if (stageChanged) {
          const stage = await db.pipelineStage.findFirst({
            where: { id: data.stageId!, pipeline: { workspaceId } },
            select: { name: true },
          });
          await logActivity({
            workspaceId, actorId: actor.identity.id, type: "stage_change",
            title: `Moved to ${stage?.name ?? "a new stage"}`, opportunityId: recordId,
          });
        }

        const changes = diffFields(existing, patch, [
          "name", "stageId", "submissionStatus", "companyId",
          "estimatedValueCents", "proposalDeadlineAt",
        ]);
        if (Object.keys(changes).length > 0) {
          await audit(actor, {
            workspaceId, action: "record.updated", entityType: "opportunity", entityId: recordId,
            summary: `Updated opportunity ${data.name ?? existing.name}`, metadata: changes,
          });
        }

        revalidateRecord(["/opportunities", `/opportunities/${recordId}`]);
        return { id: recordId, name: data.name ?? existing.name };
      },
    ),
  );
}

export async function moveOpportunityToStage(
  id: string,
  stageId: string,
): Promise<ActionResult<{ id: string; unchanged: boolean }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const nextStageId = zId.parse(stageId);

        const existing = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { stageId: true, pipelineId: true },
        });
        if (existing.stageId === nextStageId) return { id: recordId, unchanged: true };

        // The stage must belong to a pipeline in this workspace, and to this
        // opportunity's own pipeline when it has one.
        await assertRelations(workspaceId, {
          pipelineId: existing.pipelineId,
          stageId: nextStageId,
        });

        const stage = await db.pipelineStage.findFirstOrThrow({
          where: { id: nextStageId, pipeline: { workspaceId } },
          select: { name: true },
        });

        await transaction(async (tx) => {
          await tx.opportunity.updateMany({
            where: { id: recordId, workspaceId },
            data: { stageId: nextStageId, version: { increment: 1 } },
          });
          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "stage_change",
              title: `Moved to ${stage.name}`, opportunityId: recordId,
            },
            tx,
          );
        });

        revalidateRecord(["/opportunities", `/opportunities/${recordId}`]);
        return { id: recordId, unchanged: false };
      },
    ),
  );
}

export async function archiveOpportunity(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.opportunity.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.archived", entityType: "opportunity",
          entityId: recordId, summary: "Archived an opportunity",
        });
        revalidateRecord(["/opportunities", `/opportunities/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function restoreOpportunity(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.opportunity.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: null, version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.restored", entityType: "opportunity",
          entityId: recordId, summary: "Restored an opportunity",
        });
        revalidateRecord(["/opportunities", `/opportunities/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function deleteOpportunity(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const opportunity = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { name: true },
        });
        assertConfirmation(confirmation, opportunity.name);

        await db.opportunity.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId, action: "record.deleted", entityType: "opportunity", entityId: recordId,
          summary: `Permanently deleted opportunity ${opportunity.name}`,
        });

        revalidateRecord(["/opportunities"]);
        return { id: recordId };
      },
    ),
  );
}
