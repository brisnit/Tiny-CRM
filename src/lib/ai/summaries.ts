import "server-only";

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { getProvider } from "@/lib/ai/provider";
import { SYSTEM_PROMPTS, withContext } from "@/lib/ai/prompts";
import { buildRecordContext, buildWorkspaceSnapshot, type ContextScope } from "@/lib/ai/context";
import { recordUsage, type SessionUser } from "@/lib/auth/session";
import { assertWithinLimit } from "@/lib/auth/session";

export type SummaryKind = "summary" | "brief" | "deal_score";

/**
 * Summaries are cached against a fingerprint of the context that produced them.
 * That is what makes an AI summary on every record affordable: the model runs
 * when the underlying record has actually changed, not on every page view.
 */
function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export async function getRecordSummary(
  user: SessionUser,
  scope: ContextScope,
  entityType: "contact" | "company" | "deal" | "project" | "opportunity",
  entityId: string,
  options: { force?: boolean; workspaceId: string } = { workspaceId: "" },
): Promise<{ body: string; cached: boolean; model: string | null; generatedAt: Date } | null> {
  const context = await buildRecordContext(scope, entityType, entityId);
  if (!context) return null;

  const print = fingerprint(context.text);

  if (!options.force) {
    const cached = await db.aiInsight.findFirst({
      where: { entityType, entityId, kind: "summary", fingerprint: print },
      orderBy: { createdAt: "desc" },
    });
    if (cached) {
      return { body: cached.body, cached: true, model: cached.model, generatedAt: cached.createdAt };
    }
  }

  await assertWithinLimit(user, "aiRequestsPerMonth");

  const provider = getProvider();
  const result = await provider.complete({
    purpose: "record_summary",
    system: SYSTEM_PROMPTS.recordSummary,
    effort: "low",
    maxTokens: 700,
    messages: [{ role: "user", content: withContext("Summarise this record.", context.text) }],
  });

  await recordUsage(user.id, "ai_requests");

  const workspaceId = options.workspaceId || (await resolveWorkspaceId(entityType, entityId));
  if (!workspaceId) return { body: result.text, cached: false, model: result.model, generatedAt: new Date() };

  // Supersede rather than accumulate: one live summary per record.
  await db.aiInsight.deleteMany({ where: { entityType, entityId, kind: "summary" } });
  const insight = await db.aiInsight.create({
    data: {
      workspaceId,
      kind: "summary",
      entityType,
      entityId,
      title: `Summary of ${context.citations[0]?.label ?? entityType}`,
      body: result.text,
      model: `${result.provider}:${result.model}`,
      fingerprint: print,
    },
  });

  return { body: insight.body, cached: false, model: insight.model, generatedAt: insight.createdAt };
}

export async function getDailyBrief(
  user: SessionUser,
  scope: ContextScope,
  options: { force?: boolean } = {},
): Promise<{ body: string; cached: boolean; model: string | null; generatedAt: Date }> {
  const snapshot = await buildWorkspaceSnapshot(scope, { limit: 14 });
  const print = fingerprint(snapshot.text);
  const scopeKey = scope.workspaceIds.slice().sort().join(",");

  if (!options.force) {
    const cached = await db.aiInsight.findFirst({
      where: { kind: "brief", entityType: "user", entityId: `${user.id}:${scopeKey}`, fingerprint: print },
      orderBy: { createdAt: "desc" },
    });
    // Briefs also expire on the hour so "today" stays meaningful even when
    // nothing in the CRM has changed.
    if (cached && Date.now() - cached.createdAt.getTime() < 60 * 60 * 1000) {
      return { body: cached.body, cached: true, model: cached.model, generatedAt: cached.createdAt };
    }
  }

  await assertWithinLimit(user, "aiRequestsPerMonth");

  const provider = getProvider();
  const result = await provider.complete({
    purpose: "daily_brief",
    system: SYSTEM_PROMPTS.dailyBrief,
    effort: "medium",
    maxTokens: 1100,
    messages: [
      {
        role: "user",
        content: withContext(
          `Write my brief. Today is ${new Date().toDateString()}. My name is ${user.name.split(" ")[0]}.`,
          snapshot.text,
        ),
      },
    ],
  });

  await recordUsage(user.id, "ai_requests");

  const workspaceId = scope.workspaceIds[0];
  if (workspaceId) {
    await db.aiInsight.deleteMany({
      where: { kind: "brief", entityType: "user", entityId: `${user.id}:${scopeKey}` },
    });
    await db.aiInsight.create({
      data: {
        workspaceId,
        kind: "brief",
        entityType: "user",
        entityId: `${user.id}:${scopeKey}`,
        title: "Daily brief",
        body: result.text,
        model: `${result.provider}:${result.model}`,
        fingerprint: print,
      },
    });
  }

  return { body: result.text, cached: false, model: result.model, generatedAt: new Date() };
}

async function resolveWorkspaceId(entityType: string, entityId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = await (db as any)[entityType].findUnique({
    where: { id: entityId },
    select: { workspaceId: true },
  });
  return record?.workspaceId ?? null;
}
