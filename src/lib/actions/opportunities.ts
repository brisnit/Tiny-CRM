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
import { formatDayOnly } from "@/lib/dates";
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

// ---------------------------------------------------------------------------
// The submission lifecycle
// ---------------------------------------------------------------------------

/**
 * The pipeline stage each lifecycle state belongs in, by name.
 *
 * A workspace owns its own pipeline, so this is a best-effort match rather than
 * a contract: if the stage exists, the record moves with the lifecycle; if it
 * does not, the stage is left exactly where it was. Nothing here ever creates a
 * stage — inventing one would rewrite a workspace's process because somebody
 * pressed a button on one record.
 *
 * There is deliberately no entry for "under_review" or "shortlisted": those are
 * facts about the buyer's process, not positions in our pipeline.
 */
const STAGE_FOR_STATUS: Record<string, string> = {
  submitted: "Submitted",
  won: "Awarded",
  lost: "Not Awarded",
  withdrawn: "Withdrawn",
};

/** The stage this state belongs in, within this opportunity's own pipeline, or null. */
async function stageForStatus(
  tx: Parameters<Parameters<typeof transaction>[0]>[0],
  pipelineId: string | null,
  status: string,
): Promise<{ id: string; name: string } | null> {
  const wanted = STAGE_FOR_STATUS[status];
  if (!wanted || !pipelineId) return null;
  const stages = await tx.pipelineStage.findMany({
    where: { pipelineId },
    select: { id: true, name: true },
  });
  // Compared here rather than in the query: Prisma's case-insensitive filter is
  // PostgreSQL-only, and this runs on SQLite too.
  return stages.find((s) => s.name.trim().toLowerCase() === wanted.toLowerCase()) ?? null;
}

const markSubmittedSchema = z.object({
  /** Defaults to today; editable, because a submission may be recorded later. */
  submittedAt: zOptionalDate,
  decisionExpectedAt: zOptionalDate,
  version: zVersion,
});

/**
 * Records that the proposal went in.
 *
 * This is the moment the submission deadline stops being an obligation: from
 * here the card reads "Submitted", and a project whose target date is this
 * RFP's deadline stops reporting overdue (src/lib/rfp-lifecycle.ts). The
 * deadline itself is never touched — it stays the historical record.
 */
export async function markOpportunitySubmitted(
  id: string,
  input: { submittedAt?: string | Date | null; decisionExpectedAt?: string | Date | null; version?: number },
): Promise<ActionResult<{ id: string; name: string; stageMovedTo: string | null }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = markSubmittedSchema.parse(input);

        const existing = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            name: true, stageId: true, pipelineId: true, projectId: true,
            submissionStatus: true, submittedAt: true, proposalDeadlineAt: true,
          },
        });

        const submittedAt = data.submittedAt ?? new Date();

        const moved = await transaction(async (tx) => {
          const stage = await stageForStatus(tx, existing.pipelineId, "submitted");
          const moveTo = stage && stage.id !== existing.stageId ? stage : null;

          const result = await tx.opportunity.updateMany({
            where: {
              id: recordId, workspaceId,
              ...(data.version !== undefined ? { version: data.version } : {}),
            },
            data: {
              submissionStatus: "submitted",
              submittedAt,
              ...(data.decisionExpectedAt !== undefined
                ? { decisionExpectedAt: data.decisionExpectedAt ?? null }
                : {}),
              ...(moveTo ? { stageId: moveTo.id } : {}),
              version: { increment: 1 },
            },
          });
          assertVersion(result.count, data.version, "opportunity");

          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "field_change",
              title: `Submitted the proposal`, opportunityId: recordId,
            },
            tx,
          );
          if (moveTo) {
            await logActivity(
              {
                workspaceId, actorId: actor.identity.id, type: "stage_change",
                title: `Moved to ${moveTo.name}`, opportunityId: recordId,
              },
              tx,
            );
          }
          await emitEvent(
            {
              workspaceId, name: "opportunity.submitted", entityType: "opportunity",
              entityId: recordId, actorId: actor.identity.id,
              payload: { submittedAt: submittedAt.toISOString() },
            },
            tx,
          );
          return moveTo;
        });

        await audit(actor, {
          workspaceId, action: "record.updated", entityType: "opportunity", entityId: recordId,
          summary: `Marked ${existing.name} submitted`,
          metadata: {
            submissionStatus: { from: existing.submissionStatus, to: "submitted" },
            submittedAt: { from: existing.submittedAt, to: submittedAt },
            ...(moved ? { stage: { to: moved.name } } : {}),
          },
        });

        revalidateRecord([
          "/opportunities",
          `/opportunities/${recordId}`,
          ...(existing.projectId ? ["/projects", `/projects/${existing.projectId}`] : []),
          "/home",
        ]);
        return { id: recordId, name: existing.name, stageMovedTo: moved?.name ?? null };
      },
    ),
  );
}

const lifecycleStateSchema = z.object({
  status: z.enum(["under_review", "shortlisted"]),
  version: zVersion,
});

/**
 * Moves a submitted proposal along the buyer's process.
 *
 * Manual on purpose. Tiny cannot see a buyer's shortlist, and time passing is
 * not evidence of anything — inferring "under review" from a date would be
 * inventing a fact, which is the failure this whole change exists to correct.
 */
export async function setOpportunityLifecycleState(
  id: string,
  input: { status: "under_review" | "shortlisted"; version?: number },
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = lifecycleStateSchema.parse(input);

        const existing = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { name: true, submissionStatus: true, projectId: true },
        });

        await transaction(async (tx) => {
          const result = await tx.opportunity.updateMany({
            where: {
              id: recordId, workspaceId,
              ...(data.version !== undefined ? { version: data.version } : {}),
            },
            data: { submissionStatus: data.status, version: { increment: 1 } },
          });
          assertVersion(result.count, data.version, "opportunity");
          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "field_change",
              title: data.status === "under_review" ? "Under review" : "Shortlisted",
              opportunityId: recordId,
            },
            tx,
          );
        });

        await audit(actor, {
          workspaceId, action: "record.updated", entityType: "opportunity", entityId: recordId,
          summary: `${existing.name} is ${data.status === "under_review" ? "under review" : "shortlisted"}`,
          metadata: { submissionStatus: { from: existing.submissionStatus, to: data.status } },
        });

        revalidateRecord([
          "/opportunities",
          `/opportunities/${recordId}`,
          ...(existing.projectId ? [`/projects/${existing.projectId}`] : []),
        ]);
        return { id: recordId, name: existing.name };
      },
    ),
  );
}

const outcomeSchema = z.object({
  /** Stored values are unchanged: won and lost are shown as Awarded and Not awarded. */
  outcome: z.enum(["won", "lost", "withdrawn"]),
  /** Defaults to today; editable, because an outcome may be recorded later. */
  decidedAt: zOptionalDate,
  version: zVersion,
});

const OUTCOME_LABEL: Record<string, string> = {
  won: "Awarded",
  lost: "Not awarded",
  withdrawn: "Withdrawn",
};

/**
 * Records how the pursuit ended.
 *
 * Withdrawal is an ending in its own right and does not imply the proposal was
 * ever sent — a pursuit can be abandoned while it is still being written.
 */
export async function recordOpportunityOutcome(
  id: string,
  input: { outcome: "won" | "lost" | "withdrawn"; decidedAt?: string | Date | null; version?: number },
): Promise<ActionResult<{ id: string; name: string; stageMovedTo: string | null }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = outcomeSchema.parse(input);

        const existing = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            name: true, stageId: true, pipelineId: true, projectId: true,
            submissionStatus: true, decidedAt: true,
          },
        });

        const decidedAt = data.decidedAt ?? new Date();

        const moved = await transaction(async (tx) => {
          const stage = await stageForStatus(tx, existing.pipelineId, data.outcome);
          const moveTo = stage && stage.id !== existing.stageId ? stage : null;

          const result = await tx.opportunity.updateMany({
            where: {
              id: recordId, workspaceId,
              ...(data.version !== undefined ? { version: data.version } : {}),
            },
            data: {
              submissionStatus: data.outcome,
              decidedAt,
              ...(moveTo ? { stageId: moveTo.id } : {}),
              version: { increment: 1 },
            },
          });
          assertVersion(result.count, data.version, "opportunity");

          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "field_change",
              title: OUTCOME_LABEL[data.outcome] ?? "Outcome recorded", opportunityId: recordId,
            },
            tx,
          );
          if (moveTo) {
            await logActivity(
              {
                workspaceId, actorId: actor.identity.id, type: "stage_change",
                title: `Moved to ${moveTo.name}`, opportunityId: recordId,
              },
              tx,
            );
          }
          await emitEvent(
            {
              workspaceId, name: "opportunity.decided", entityType: "opportunity",
              entityId: recordId, actorId: actor.identity.id,
              payload: { outcome: data.outcome, decidedAt: decidedAt.toISOString() },
            },
            tx,
          );
          return moveTo;
        });

        await audit(actor, {
          workspaceId, action: "record.updated", entityType: "opportunity", entityId: recordId,
          summary: `${existing.name}: ${OUTCOME_LABEL[data.outcome] ?? data.outcome}`,
          metadata: {
            submissionStatus: { from: existing.submissionStatus, to: data.outcome },
            decidedAt: { from: existing.decidedAt, to: decidedAt },
            ...(moved ? { stage: { to: moved.name } } : {}),
          },
        });

        revalidateRecord([
          "/opportunities",
          `/opportunities/${recordId}`,
          ...(existing.projectId ? ["/projects", `/projects/${existing.projectId}`] : []),
          "/home",
        ]);
        return { id: recordId, name: existing.name, stageMovedTo: moved?.name ?? null };
      },
    ),
  );
}

const decisionExpectedSchema = z.object({
  /** Null is a real answer here, not a missing one: we do not know yet. */
  decisionExpectedAt: zOptionalDate,
  version: zVersion,
});

/**
 * When we expect to hear back — including not knowing.
 *
 * A buyer's timetable is their business, and often they never say. "Unknown" is
 * therefore a state the record can hold rather than the absence of one, and it
 * is reachable in both directions: a date can be added when the buyer names one
 * and taken away again when that date turns out to mean nothing. Neither makes
 * the proposal overdue, and neither invents a follow-up — waiting is not
 * slippage, and this stores what we know rather than a guess that would read
 * like a commitment.
 */
export async function setOpportunityDecisionExpected(
  id: string,
  input: { decisionExpectedAt?: string | Date | null; version?: number },
): Promise<ActionResult<{ id: string; name: string; decisionExpectedAt: Date | null }>> {
  return guard(() =>
    recordAction("opportunity", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = decisionExpectedSchema.parse(input);
        // An omitted field means the same as an explicit null here: this action
        // exists to answer the question, and "unknown" is one of its answers.
        const expected = data.decisionExpectedAt ?? null;

        const existing = await db.opportunity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { name: true, decisionExpectedAt: true, projectId: true },
        });

        await transaction(async (tx) => {
          const result = await tx.opportunity.updateMany({
            where: {
              id: recordId, workspaceId,
              ...(data.version !== undefined ? { version: data.version } : {}),
            },
            // Written unconditionally: this action exists to be able to clear it,
            // so a null here means "unknown", never "leave it as it was".
            data: { decisionExpectedAt: expected, version: { increment: 1 } },
          });
          assertVersion(result.count, data.version, "opportunity");

          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "field_change",
              title: expected
                ? `Decision expected ${formatDayOnly(expected)}`
                : "Decision date is unknown",
              opportunityId: recordId,
            },
            tx,
          );
        });

        await audit(actor, {
          workspaceId, action: "record.updated", entityType: "opportunity", entityId: recordId,
          summary: expected
            ? `${existing.name}: decision expected ${formatDayOnly(expected)}`
            : `${existing.name}: decision date unknown`,
          metadata: {
            decisionExpectedAt: { from: existing.decisionExpectedAt, to: expected },
          },
        });

        revalidateRecord([
          "/opportunities",
          `/opportunities/${recordId}`,
          ...(existing.projectId ? ["/projects", `/projects/${existing.projectId}`] : []),
          "/home",
        ]);
        return { id: recordId, name: existing.name, decisionExpectedAt: expected };
      },
    ),
  );
}
