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
import { dispatchSoon } from "@/lib/events";
import { LEAD_SOURCE } from "@/lib/enums";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zOptionalDate, zOptionalId, zOptionalMoney, zOptionalPercent, zOptionalText,
  zShortText, zVersion,
} from "@/lib/validation/common";

const dealSchema = z.object({
  workspaceId: zId,
  name: zShortText.min(1, "Give the deal a name"),
  companyId: zOptionalId,
  primaryContactId: zOptionalId,
  projectId: zOptionalId,
  pipelineId: zId,
  stageId: zId,
  valueCents: zOptionalMoney,
  probability: zOptionalPercent,
  expectedCloseAt: zOptionalDate,
  source: z.enum(LEAD_SOURCE.values).nullish(),
  nextStep: zOptionalText(LIMITS.mediumText),
  lostReason: zOptionalText(LIMITS.mediumText),
});

const dealUpdateSchema = dealSchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type DealInput = z.input<typeof dealSchema>;
type DealUpdate = z.input<typeof dealUpdateSchema>;

/**
 * `valueCents` is deliberately absent: it is a non-nullable column, so it is
 * merged separately below rather than being allowed to write a null.
 */
const EDITABLE = [
  "name", "companyId", "primaryContactId", "projectId", "pipelineId", "stageId",
  "probability", "expectedCloseAt", "source", "nextStep", "lostReason",
] as const;

export async function createDeal(
  input: DealInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = dealSchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertWithinLimit(actor, "deals");
        // Every foreign key, including the pipeline stage — which is reached
        // through its pipeline rather than carrying a workspace of its own.
        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          primaryContactId: data.primaryContactId ?? null,
          projectId: data.projectId ?? null,
          pipelineId: data.pipelineId,
          stageId: data.stageId,
        });

        const now = new Date();
        const deal = await transaction(async (tx) => {
          const created = await tx.deal.create({
            data: {
              workspaceId,
              name: data.name,
              companyId: data.companyId ?? null,
              primaryContactId: data.primaryContactId ?? null,
              projectId: data.projectId ?? null,
              pipelineId: data.pipelineId,
              stageId: data.stageId,
              valueCents: data.valueCents ?? 0,
              probability: data.probability ?? null,
              expectedCloseAt: data.expectedCloseAt ?? null,
              source: data.source ?? null,
              nextStep: data.nextStep ?? null,
              ownerId: actor.identity.id,
              stageEnteredAt: now,
              lastActivityAt: now,
              contacts: data.primaryContactId
                ? { create: [{ contactId: data.primaryContactId, role: "Primary" }] }
                : undefined,
            },
            select: {
              id: true, name: true, companyId: true, primaryContactId: true, projectId: true,
            },
          });

          await logActivity(
            {
              workspaceId,
              actorId: actor.identity.id,
              type: "created",
              title: `Created deal ${created.name}`,
              dealId: created.id,
              companyId: created.companyId,
              contactId: created.primaryContactId,
              projectId: created.projectId,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId, name: "deal.created", entityType: "deal", entityId: created.id,
              actorId: actor.identity.id, payload: { name: created.name, valueCents: data.valueCents ?? 0 },
            },
            tx,
          );

          return created;
        });

        await audit(actor, {
          workspaceId, action: "record.created", entityType: "deal",
          entityId: deal.id, summary: `Created deal ${deal.name}`,
          metadata: { valueCents: data.valueCents ?? 0 },
        });

        dispatchSoon();
        revalidateRecord(["/deals", "/projects", "/companies"]);
        return { id: deal.id, name: deal.name };
      },
    ),
  );
}

export async function updateDeal(
  id: string,
  input: DealUpdate,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("deal", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = dealUpdateSchema.parse(input);

        const existing = await db.deal.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            name: true, stageId: true, pipelineId: true, companyId: true,
            primaryContactId: true, projectId: true, valueCents: true, expectedCloseAt: true,
          },
        });

        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          primaryContactId: data.primaryContactId ?? null,
          projectId: data.projectId ?? null,
          // A stage change must be validated against the pipeline the deal will
          // actually be on, not the one it happens to be on now.
          pipelineId: data.pipelineId ?? (data.stageId ? existing.pipelineId : null),
          stageId: data.stageId ?? null,
        });

        const stageChanged = Boolean(data.stageId && data.stageId !== existing.stageId);
        const patch = {
          ...pickDefined(data, EDITABLE),
          ...(data.valueCents != null ? { valueCents: data.valueCents } : {}),
        };

        const result = await db.deal.updateMany({
          where: {
            id: recordId, workspaceId,
            ...(data.version !== undefined ? { version: data.version } : {}),
          },
          data: {
            ...patch,
            // Entering a new stage restarts the "days in stage" clock that
            // momentum scoring and stall detection both read.
            ...(stageChanged ? { stageEnteredAt: new Date() } : {}),
            version: { increment: 1 },
          },
        });
        assertVersion(result.count, data.version, "deal");

        if (stageChanged) {
          await afterStageChange(actor.identity.id, workspaceId, recordId, existing.stageId, data.stageId!);
        }

        const changes = diffFields(existing, patch, [
          "name", "stageId", "companyId", "primaryContactId", "projectId",
          "valueCents", "expectedCloseAt",
        ]);
        if (Object.keys(changes).length > 0) {
          await audit(actor, {
            workspaceId, action: "record.updated", entityType: "deal", entityId: recordId,
            summary: `Updated deal ${data.name ?? existing.name}`, metadata: changes,
          });
        }

        dispatchSoon();
        revalidateRecord(["/deals", `/deals/${recordId}`, "/projects"]);
        return { id: recordId, name: data.name ?? existing.name };
      },
    ),
  );
}

/**
 * Drag-and-drop on the pipeline board lands here.
 *
 * The prototype wrote `stageId` straight through, so a member of one workspace
 * could drop a deal onto another tenant's stage and have that stage's name and
 * colour rendered back to them. `assertRelations` is what closes it: the stage
 * must resolve through a pipeline in *this* workspace.
 */
export async function moveDealToStage(
  id: string,
  stageId: string,
): Promise<ActionResult<{ id: string; unchanged: boolean }>> {
  return guard(() =>
    recordAction("deal", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const nextStageId = zId.parse(stageId);

        const existing = await db.deal.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { stageId: true, pipelineId: true },
        });
        if (existing.stageId === nextStageId) return { id: recordId, unchanged: true };

        await assertRelations(workspaceId, {
          pipelineId: existing.pipelineId,
          stageId: nextStageId,
        });

        await db.deal.updateMany({
          where: { id: recordId, workspaceId },
          data: { stageId: nextStageId, stageEnteredAt: new Date(), version: { increment: 1 } },
        });

        await afterStageChange(actor.identity.id, workspaceId, recordId, existing.stageId, nextStageId);

        dispatchSoon();
        revalidateRecord(["/deals", `/deals/${recordId}`, "/home"]);
        return { id: recordId, unchanged: false };
      },
    ),
  );
}

/**
 * Everything that follows a stage change: the closed-at stamp, the timeline
 * entry and the domain event the automation engine consumes.
 *
 * Every query here is workspace-scoped even though the caller has already
 * proven access — defence in depth costs one extra WHERE clause.
 */
async function afterStageChange(
  userId: string,
  workspaceId: string,
  dealId: string,
  fromId: string,
  toId: string,
) {
  const [deal, from, to] = await Promise.all([
    db.deal.findFirstOrThrow({
      where: { id: dealId, workspaceId },
      select: {
        id: true, name: true, companyId: true, primaryContactId: true,
        projectId: true, valueCents: true,
      },
    }),
    db.pipelineStage.findFirst({
      where: { id: fromId, pipeline: { workspaceId } },
      select: { name: true },
    }),
    db.pipelineStage.findFirstOrThrow({
      where: { id: toId, pipeline: { workspaceId } },
      select: { name: true, kind: true, probability: true },
    }),
  ]);

  const closed = to.kind === "won" || to.kind === "lost";

  await transaction(async (tx) => {
    // Closing a deal stamps closedAt so win-rate and cycle-time analytics work.
    await tx.deal.updateMany({
      where: { id: dealId, workspaceId },
      data: { closedAt: closed ? new Date() : null },
    });

    await logActivity(
      {
        workspaceId,
        actorId: userId,
        type: "stage_change",
        title: `Moved to ${to.name}`,
        body: from ? `From ${from.name} to ${to.name}.` : null,
        meta: { from: from?.name ?? null, to: to.name, kind: to.kind },
        dealId: deal.id,
        companyId: deal.companyId,
        contactId: deal.primaryContactId,
        projectId: deal.projectId,
      },
      tx,
    );

    await emitEvent(
      {
        workspaceId,
        name: to.kind === "won" ? "deal.won" : to.kind === "lost" ? "deal.lost" : "deal.stage.changed",
        entityType: "deal",
        entityId: deal.id,
        actorId: userId,
        payload: {
          stageName: to.name,
          stageKind: to.kind,
          dealName: deal.name,
          valueCents: deal.valueCents,
          fromStage: from?.name ?? null,
        },
      },
      tx,
    );
  });
}

export async function archiveDeal(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("deal", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.deal.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.archived", entityType: "deal",
          entityId: recordId, summary: "Archived a deal",
        });
        revalidateRecord(["/deals", `/deals/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function restoreDeal(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("deal", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.deal.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: null, version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.restored", entityType: "deal",
          entityId: recordId, summary: "Restored a deal",
        });
        revalidateRecord(["/deals", `/deals/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function deleteDeal(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("deal", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const deal = await db.deal.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { name: true, valueCents: true },
        });
        assertConfirmation(confirmation, deal.name);

        await db.deal.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId, action: "record.deleted", entityType: "deal", entityId: recordId,
          summary: `Permanently deleted deal ${deal.name}`,
          metadata: { valueCents: deal.valueCents },
        });

        revalidateRecord(["/deals"]);
        return { id: recordId };
      },
    ),
  );
}
