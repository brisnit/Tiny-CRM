import "server-only";

import { db } from "@/lib/db";
import { getProvider } from "@/lib/ai/provider";
import { SYSTEM_PROMPTS, withContext } from "@/lib/ai/prompts";
import { buildRecordContext, buildWorkspaceSnapshot, type ContextScope } from "@/lib/ai/context";
import { assertWithinLimit, recordUsage, type SessionUser } from "@/lib/auth/session";
import type { AiMessage } from "@/lib/ai/provider";

/**
 * The conversational agent behind ⌘K and the Tiny AI panel.
 *
 * The important design point is that retrieval happens *before* the model is
 * called and is scoped to workspaces the caller already holds. The model never
 * gets to choose what data it sees, which means a prompt-injected note cannot
 * widen its own access.
 */

export type AgentRequest = {
  user: SessionUser;
  scope: ContextScope;
  question: string;
  history?: AiMessage[];
  /** Anchors the answer to one record when asked from a record page. */
  focus?: { type: "contact" | "company" | "deal" | "project" | "opportunity"; id: string } | null;
  threadId?: string | null;
};

export async function* askTinyAi(request: AgentRequest): AsyncIterable<string> {
  await assertWithinLimit(request.user, "aiRequestsPerMonth");

  const context = request.focus
    ? await buildRecordContext(request.scope, request.focus.type, request.focus.id)
    : await buildWorkspaceSnapshot(request.scope, { limit: 14 });

  const provider = getProvider();
  const messages: AiMessage[] = [
    ...(request.history ?? []).slice(-6),
    { role: "user", content: withContext(request.question, context?.text ?? "No records in scope.") },
  ];

  let full = "";
  for await (const chunk of provider.stream({
    purpose: "agent",
    system: SYSTEM_PROMPTS.agent,
    effort: "medium",
    maxTokens: 2000,
    messages,
  })) {
    full += chunk;
    yield chunk;
  }

  await recordUsage(request.user.id, "ai_requests");

  if (request.threadId) {
    await db.aiMessage.createMany({
      data: [
        { threadId: request.threadId, userId: request.user.id, role: "user", content: request.question },
        {
          threadId: request.threadId,
          role: "assistant",
          content: full,
          meta: JSON.stringify({ provider: provider.id, model: provider.model }),
        },
      ],
    });
    await db.aiThread.update({ where: { id: request.threadId }, data: { updatedAt: new Date() } });
  }
}

/** Non-streaming variant, used by server components and API consumers. */
export async function askTinyAiOnce(request: AgentRequest): Promise<string> {
  let out = "";
  for await (const chunk of askTinyAi(request)) out += chunk;
  return out;
}

export async function ensureThread(userId: string, workspaceId: string | null, title?: string) {
  const existing = await db.aiThread.findFirst({
    where: { userId, workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  // Continue today's thread rather than starting a new one on every question.
  if (existing && Date.now() - existing.updatedAt.getTime() < 6 * 60 * 60 * 1000) return existing;

  return db.aiThread.create({
    data: { userId, workspaceId, title: title?.slice(0, 80) ?? "New conversation" },
  });
}

export const SUGGESTED_QUESTIONS = [
  "What do I need to do today?",
  "Which deals need attention?",
  "Who haven't I talked to in 30 days?",
  "What projects are at risk?",
  "What opportunities are closing this month?",
  "What should I follow up on?",
  "Which leads look most promising?",
  "What happened this week?",
];
