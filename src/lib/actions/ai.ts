"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  action, audit, emitEvent, guard, recordAction, revalidatePathSafely, revalidateRecord,
  transaction, workspaceAction, type ActionResult, type Actor,
} from "@/lib/actions/base";
import { assertRelations, requireActor, resolveReadScope } from "@/lib/auth/access";
import { getDailyBrief, getRecordSummary } from "@/lib/ai/summaries";
import { classifyText, type Proposal } from "@/lib/ai/classification";
import { findRecommendations } from "@/lib/ai/recommendations";
import { sanitizeHtml } from "@/lib/sanitize";
import { setTags } from "@/lib/actions/tags";
import { LIMITS } from "@/lib/validation/limits";
import { zId, zOptionalId, zOptionalInt, zScope, zShortText } from "@/lib/validation/common";
import type { ContextScope } from "@/lib/ai/context";

/**
 * Tiny AI's write surface.
 *
 * Two rules govern this file, and both are structural rather than prompted:
 *
 *  1. **The model never determines authorization.** Scope is resolved from the
 *     session *before* any generation, and retrieval is filtered to it. A model
 *     cannot ask for a workspace, and no prompt it produces is used to select
 *     records.
 *  2. **The model never writes.** `classifyText` returns *proposals*. Nothing
 *     reaches the database until a user ticks them and calls `applyProposals`,
 *     which then re-validates every id the proposal carries against the target
 *     workspace — because a proposal's payload has passed through model output
 *     and is therefore untrusted input, not a capability.
 */

/** Builds the retrieval scope from the session. Never from a request or a model. */
async function scopeFor(scopeParam?: string | null): Promise<{ actor: Actor; scope: ContextScope }> {
  const actor = await requireActor();
  const { workspaceIds, memberships } = await resolveReadScope(zScope.parse(scopeParam ?? null));
  return {
    actor,
    scope: {
      workspaceIds,
      workspaceNames: new Map(memberships.map((m) => [m.id, m.name])),
    },
  };
}

export async function refreshDailyBrief(scopeParam?: string | null) {
  return guard(() =>
    action(
      async () => {
        const { actor, scope } = await scopeFor(scopeParam);
        const brief = await getDailyBrief(actor, scope, { force: true });
        revalidatePathSafely("/home");
        return brief;
      },
      { rateLimit: "ai" },
    ),
  );
}

/**
 * Summarises one record.
 *
 * The workspace comes from the record, via `recordAction` — the caller does not
 * get to say which workspace the summary is "for". Retrieval is then restricted
 * to that single workspace rather than the caller's whole scope, so a summary
 * cannot pull in context from a workspace the record does not belong to.
 */
export async function refreshRecordSummary(
  entityType: "contact" | "company" | "deal" | "project" | "opportunity",
  entityId: string,
) {
  return guard(async () => {
    const kind = z
      .enum(["contact", "company", "deal", "project", "opportunity"])
      .parse(entityType);

    return recordAction(kind, entityId, { permission: "ai:use", rateLimit: "ai" },
      async ({ actor, workspaceId, recordId }) => {
        const scope: ContextScope = {
          workspaceIds: [workspaceId],
          workspaceNames: new Map(
            actor.memberships.filter((m) => m.id === workspaceId).map((m) => [m.id, m.name]),
          ),
        };

        const summary = await getRecordSummary(actor, scope, kind, recordId, {
          force: true,
          workspaceId,
        });
        revalidatePathSafely(`/${kind}s/${recordId}`);
        return summary;
      },
    );
  });
}

export async function analyzeText(text: string, scopeParam?: string | null) {
  return guard(() =>
    action(
      async () => {
        const input = z.string().trim().min(1, "Paste something first").max(LIMITS.maxAiQuestion).parse(text);
        const { actor, scope } = await scopeFor(scopeParam);
        return classifyText(actor, scope.workspaceIds, input);
      },
      { rateLimit: "ai" },
    ),
  );
}

/**
 * A proposal, as it arrives back from the browser.
 *
 * This is re-parsed rather than trusted: the round trip through the client means
 * the payload the user approves is not necessarily the payload the model
 * produced, and neither is trusted anyway.
 */
const proposalSchema = z.object({
  id: zShortText.max(40),
  kind: z.enum(["company", "contact", "opportunity", "task", "note", "date"]),
  label: zShortText,
  detail: zShortText.optional(),
  matchId: zOptionalId,
  matchLabel: zShortText.optional(),
  isNew: z.boolean().optional(),
  payload: z.record(z.string().max(60), z.unknown()).default({}),
});

const applySchema = z.object({
  workspaceId: zId,
  proposals: z.array(proposalSchema).max(LIMITS.maxAiProposals),
  sourceText: z.string().max(LIMITS.maxAiQuestion),
});

/**
 * Applies the proposals the user ticked. Nothing is written until this runs —
 * Tiny AI proposes, the user decides.
 */
export async function applyProposals(
  workspaceId: string,
  proposals: Proposal[],
  sourceText: string,
): Promise<ActionResult<{ created: { type: string; id: string; label: string }[]; noteId: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "ai:apply", rateLimit: "mutation" },
      async (actor) => {
        const data = applySchema.parse({ workspaceId, proposals, sourceText });
        const scopedWorkspaceId = actor.workspaceId;

        // Every `matchId` the batch wants to link to must already belong to this
        // workspace. Without this a proposal could name any id in the database
        // and have it attached to the caller's own records.
        for (const proposal of data.proposals) {
          if (!proposal.matchId) continue;
          const model =
            proposal.kind === "company" ? "companyId"
            : proposal.kind === "contact" ? "contactId"
            : proposal.kind === "opportunity" ? "opportunityId"
            : proposal.kind === "task" ? "taskId"
            : proposal.kind === "note" ? "noteId"
            : null;
          if (!model) continue;
          await assertRelations(scopedWorkspaceId, { [model]: proposal.matchId });
        }

        const created: { type: string; id: string; label: string }[] = [];
        const companyIds = new Map<string, string>();
        let contactId: string | null = null;

        const result = await transaction(async (tx) => {
          for (const p of data.proposals.filter((x) => x.kind === "company")) {
            if (p.matchId) {
              companyIds.set(String(p.payload.name ?? "").toLowerCase(), p.matchId);
              continue;
            }
            const company = await tx.company.create({
              data: {
                workspaceId: scopedWorkspaceId,
                name: text(p.payload.name, "Untitled company"),
                ownerId: actor.identity.id,
                relationshipStatus: "prospect",
              },
              select: { id: true, name: true },
            });
            companyIds.set(company.name.toLowerCase(), company.id);
            created.push({ type: "company", id: company.id, label: company.name });
          }

          for (const p of data.proposals.filter((x) => x.kind === "contact")) {
            if (p.matchId) {
              contactId ??= p.matchId;
              continue;
            }
            const companyName = p.payload.companyName
              ? String(p.payload.companyName).toLowerCase()
              : null;
            const linkedCompany = companyName ? companyIds.get(companyName) ?? null : null;
            const firstName = text(p.payload.firstName ?? p.payload.name, "Unnamed");
            const lastName = text(p.payload.lastName, "");

            const contact = await tx.contact.create({
              data: {
                workspaceId: scopedWorkspaceId,
                firstName,
                lastName,
                fullName: `${firstName} ${lastName}`.trim(),
                jobTitle: optionalText(p.payload.jobTitle),
                companyId: linkedCompany,
                ownerId: actor.identity.id,
                relationshipType: "prospect",
                lastContactedAt: new Date(),
              },
              select: { id: true, fullName: true },
            });
            contactId ??= contact.id;
            created.push({ type: "contact", id: contact.id, label: contact.fullName });
          }

          const firstCompanyId = companyIds.values().next().value ?? null;

          for (const p of data.proposals.filter((x) => x.kind === "opportunity")) {
            const pipeline = await tx.pipeline.findFirst({
              where: { workspaceId: scopedWorkspaceId, kind: "opportunity" },
              select: { id: true, stages: { select: { id: true }, orderBy: { order: "asc" }, take: 1 } },
            });
            const opportunity = await tx.opportunity.create({
              data: {
                workspaceId: scopedWorkspaceId,
                name: text(p.payload.name, "Untitled opportunity"),
                ownerId: actor.identity.id,
                pipelineId: pipeline?.id ?? null,
                stageId: pipeline?.stages[0]?.id ?? null,
                estimatedValueCents: money(p.payload.value),
                companyId: firstCompanyId,
              },
              select: { id: true, name: true },
            });
            created.push({ type: "opportunity", id: opportunity.id, label: opportunity.name });
          }

          for (const p of data.proposals.filter((x) => x.kind === "task")) {
            const dueInDays = zOptionalInt(0, 3_650).parse(p.payload.dueInDays ?? null);
            const priority = ["low", "medium", "high", "urgent"].includes(String(p.payload.priority))
              ? String(p.payload.priority)
              : "medium";
            const task = await tx.task.create({
              data: {
                workspaceId: scopedWorkspaceId,
                title: text(p.payload.title, "Follow up"),
                ownerId: actor.identity.id,
                priority,
                dueAt: dueInDays == null ? null : daysFromNow(dueInDays),
                contactId,
                companyId: firstCompanyId,
              },
              select: { id: true, title: true },
            });
            created.push({ type: "task", id: task.id, label: task.title });
          }

          // The original text is kept as a note so the CRM records where these
          // records came from. It is sanitised like any other user content.
          const body = sanitizeHtml(`<p>${escapeHtml(data.sourceText).replace(/\n/g, "<br>")}</p>`);
          const note = await tx.note.create({
            data: {
              workspaceId: scopedWorkspaceId,
              title: "Captured with Tiny AI",
              body,
              plainText: data.sourceText,
              authorId: actor.identity.id,
              contactId,
              companyId: firstCompanyId,
            },
            select: { id: true },
          });

          await emitEvent(
            {
              workspaceId: scopedWorkspaceId,
              name: "ai.suggestion.applied",
              entityType: "note",
              entityId: note.id,
              actorId: actor.identity.id,
              payload: { created: created.length },
            },
            tx,
          );

          return { created, noteId: note.id };
        });

        await setTags(scopedWorkspaceId, "note", result.noteId, ["AI"]);

        await audit(actor, {
          workspaceId: scopedWorkspaceId,
          action: "ai.suggestion_applied",
          entityType: "note",
          entityId: result.noteId,
          summary: `Applied ${result.created.length} AI proposals`,
          metadata: { kinds: result.created.map((c) => c.type) },
        });

        revalidateRecord(["/contacts", "/companies", "/opportunities", "/tasks", "/notes"]);
        return result;
      },
    ),
  );
}

export async function getCleanupSuggestions(scopeParam?: string | null) {
  return guard(() =>
    action(
      async () => {
        const { scope } = await scopeFor(scopeParam);
        return findRecommendations(scope);
      },
      { rateLimit: "ai" },
    ),
  );
}

const recommendationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("link_company"),
    contactId: zId,
    companyId: zId,
  }),
  z.object({
    type: z.literal("create_task"),
    title: zShortText.min(1),
    dueInDays: zOptionalInt(0, 365),
    contactId: zOptionalId,
    dealId: zOptionalId,
    projectId: zOptionalId,
  }),
]);

/**
 * One-click resolution for a hygiene finding.
 *
 * The prototype's version had no ownership check at all and took its target ids
 * straight from the payload, so it could rewrite any contact in the database
 * (F-02). Every id is now proven to belong to the caller's workspace before it
 * is used, and the write itself is workspace-filtered as well.
 */
export async function applyRecommendation(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: string,
): Promise<ActionResult<{ applied: boolean }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "ai:apply", rateLimit: "mutation" },
      async (actor) => {
        const data = recommendationSchema.parse({ type, ...payload });
        const scopedWorkspaceId = actor.workspaceId;

        switch (data.type) {
          case "link_company": {
            await assertRelations(scopedWorkspaceId, {
              contactId: data.contactId,
              companyId: data.companyId,
            });
            const result = await db.contact.updateMany({
              where: { id: data.contactId, workspaceId: scopedWorkspaceId },
              data: { companyId: data.companyId, version: { increment: 1 } },
            });
            if (result.count === 0) return { applied: false };
            break;
          }
          case "create_task": {
            await assertRelations(scopedWorkspaceId, {
              contactId: data.contactId ?? null,
              dealId: data.dealId ?? null,
              projectId: data.projectId ?? null,
            });
            await db.task.create({
              data: {
                workspaceId: scopedWorkspaceId,
                title: data.title,
                ownerId: actor.identity.id,
                priority: "high",
                dueAt: daysFromNow(data.dueInDays ?? 1),
                contactId: data.contactId ?? null,
                dealId: data.dealId ?? null,
                projectId: data.projectId ?? null,
              },
            });
            break;
          }
        }

        await audit(actor, {
          workspaceId: scopedWorkspaceId,
          action: "ai.suggestion_applied",
          summary: `Applied cleanup suggestion: ${data.type}`,
          metadata: { type: data.type },
        });

        revalidateRecord(["/contacts", "/tasks", "/home"]);
        return { applied: true };
      },
    ),
  );
}

export async function dismissInsight(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("aiInsight", id, { permission: "ai:use", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        await db.aiInsight.updateMany({
          where: { id: recordId, workspaceId },
          data: { status: "dismissed" },
        });
        revalidatePathSafely("/home");
        return { id: recordId };
      },
    ),
  );
}

function daysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(17, 0, 0, 0);
  return d;
}

/** Coerces model-produced payload values into bounded strings. */
function text(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return (raw || fallback).slice(0, 200);
}

function optionalText(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? raw.slice(0, 200) : null;
}

function money(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return Math.abs(cents) > LIMITS.maxMoneyCents ? null : cents;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type { Proposal };
