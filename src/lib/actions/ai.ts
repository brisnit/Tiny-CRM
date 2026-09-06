"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { action } from "@/lib/actions/base";
import { getUserWorkspaces, resolveScope, requireWorkspace } from "@/lib/auth/session";
import { getDailyBrief, getRecordSummary } from "@/lib/ai/summaries";
import { classifyText, type Proposal } from "@/lib/ai/classification";
import { findRecommendations } from "@/lib/ai/recommendations";
import { setTags } from "@/lib/actions/tags";

async function scopeFor(userId: string, scopeParam?: string | null) {
  const { workspaceIds } = await resolveScope(userId, scopeParam);
  const workspaces = await getUserWorkspaces(userId);
  return { workspaceIds, workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])) };
}

export async function refreshDailyBrief(scopeParam?: string | null) {
  return action(async (user) => {
    const scope = await scopeFor(user.id, scopeParam);
    const brief = await getDailyBrief(user, scope, { force: true });
    revalidatePath("/home");
    return brief;
  });
}

export async function refreshRecordSummary(
  entityType: "contact" | "company" | "deal" | "project" | "opportunity",
  entityId: string,
  workspaceId: string,
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId);
    const scope = await scopeFor(user.id, "all");
    const summary = await getRecordSummary(user, scope, entityType, entityId, {
      force: true,
      workspaceId,
    });
    revalidatePath(`/${entityType}s/${entityId}`);
    return summary;
  });
}

export async function analyzeText(text: string, scopeParam?: string | null) {
  return action(async (user) => {
    const { workspaceIds } = await resolveScope(user.id, scopeParam);
    return classifyText(user, workspaceIds, text);
  });
}

/**
 * Applies the proposals the user ticked. Nothing is written until this runs —
 * Tiny AI proposes, the user decides.
 */
export async function applyProposals(
  workspaceId: string,
  proposals: Proposal[],
  sourceText: string,
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId);

    const created: { type: string; id: string; label: string }[] = [];
    const companyIds = new Map<string, string>();
    let contactId: string | null = null;

    for (const p of proposals.filter((x) => x.kind === "company")) {
      if (p.matchId) {
        companyIds.set(String(p.payload.name).toLowerCase(), p.matchId);
        continue;
      }
      const company = await db.company.create({
        data: { workspaceId, name: String(p.payload.name), ownerId: user.id, relationshipStatus: "prospect" },
      });
      companyIds.set(company.name.toLowerCase(), company.id);
      created.push({ type: "company", id: company.id, label: company.name });
    }

    for (const p of proposals.filter((x) => x.kind === "contact")) {
      if (p.matchId) {
        contactId ??= p.matchId;
        continue;
      }
      const companyName = p.payload.companyName ? String(p.payload.companyName).toLowerCase() : null;
      const linkedCompany = (p.payload.companyId as string | null) ?? (companyName ? companyIds.get(companyName) ?? null : null);
      const firstName = String(p.payload.firstName ?? p.payload.name ?? "").trim();
      const lastName = String(p.payload.lastName ?? "").trim();

      const contact = await db.contact.create({
        data: {
          workspaceId,
          firstName: firstName || String(p.payload.name),
          lastName,
          fullName: `${firstName} ${lastName}`.trim(),
          jobTitle: (p.payload.jobTitle as string | null) ?? null,
          companyId: linkedCompany,
          ownerId: user.id,
          relationshipType: "prospect",
          lastContactedAt: new Date(),
        },
      });
      contactId ??= contact.id;
      created.push({ type: "contact", id: contact.id, label: contact.fullName });
    }

    for (const p of proposals.filter((x) => x.kind === "opportunity")) {
      const pipeline = await db.pipeline.findFirst({
        where: { workspaceId, kind: "opportunity" },
        select: { id: true, stages: { select: { id: true }, orderBy: { order: "asc" }, take: 1 } },
      });
      const opportunity = await db.opportunity.create({
        data: {
          workspaceId,
          name: String(p.payload.name),
          ownerId: user.id,
          pipelineId: pipeline?.id ?? null,
          stageId: pipeline?.stages[0]?.id ?? null,
          estimatedValueCents: p.payload.value ? Math.round(Number(p.payload.value) * 100) : null,
          companyId: companyIds.values().next().value ?? null,
        },
      });
      created.push({ type: "opportunity", id: opportunity.id, label: opportunity.name });
    }

    for (const p of proposals.filter((x) => x.kind === "task")) {
      const dueInDays = p.payload.dueInDays as number | null;
      const task = await db.task.create({
        data: {
          workspaceId,
          title: String(p.payload.title),
          ownerId: user.id,
          priority: String(p.payload.priority ?? "medium"),
          dueAt: dueInDays === null || dueInDays === undefined ? null : daysFromNow(dueInDays),
          contactId,
          companyId: companyIds.values().next().value ?? null,
        },
      });
      created.push({ type: "task", id: task.id, label: task.title });
    }

    // The original text is kept as a note so the CRM records where these
    // records came from.
    const note = await db.note.create({
      data: {
        workspaceId,
        title: "Captured with Tiny AI",
        body: `<p>${escapeHtml(sourceText).replace(/\n/g, "<br>")}</p>`,
        plainText: sourceText,
        authorId: user.id,
        contactId,
        companyId: companyIds.values().next().value ?? null,
      },
    });
    await setTags(workspaceId, "note", note.id, ["AI"]);

    revalidatePath("/", "layout");
    return { created, noteId: note.id };
  });
}

export async function getCleanupSuggestions(scopeParam?: string | null) {
  return action(async (user) => {
    const scope = await scopeFor(user.id, scopeParam);
    return findRecommendations(scope);
  });
}

/** One-click resolution for a hygiene finding. */
export async function applyRecommendation(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: string,
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId);

    switch (type) {
      case "link_company": {
        await db.contact.update({
          where: { id: String(payload.contactId) },
          data: { companyId: String(payload.companyId) },
        });
        break;
      }
      case "create_task": {
        await db.task.create({
          data: {
            workspaceId,
            title: String(payload.title),
            ownerId: user.id,
            priority: "high",
            dueAt: daysFromNow(Number(payload.dueInDays ?? 1)),
            contactId: (payload.contactId as string) ?? null,
            dealId: (payload.dealId as string) ?? null,
            projectId: (payload.projectId as string) ?? null,
          },
        });
        break;
      }
      default:
        return { applied: false };
    }

    revalidatePath("/", "layout");
    return { applied: true };
  });
}

export async function dismissInsight(id: string) {
  return action(async (user) => {
    const insight = await db.aiInsight.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, insight.workspaceId);
    await db.aiInsight.update({ where: { id }, data: { status: "dismissed" } });
    revalidatePath("/home");
    return { id };
  });
}

function daysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(17, 0, 0, 0);
  return d;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
