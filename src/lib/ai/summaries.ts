import "server-only";

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { getProvider, getProviderForWorkspace, offlineProvider } from "@/lib/ai/provider";
import { SYSTEM_PROMPTS, withContext } from "@/lib/ai/prompts";
import { buildRecordContext, buildWorkspaceSnapshot, type ContextScope } from "@/lib/ai/context";
import { reserveAiOrThrow } from "@/lib/entitlements";
import { AiAllowanceError, PlanLimitError } from "@/lib/plans";
import { log } from "@/lib/logger";
import type { Actor } from "@/lib/auth/access";
import { withTenantContext } from "@/lib/tenant-db";

export type SummaryKind = "summary" | "brief" | "deal_score";

/**
 * Summaries are cached against a fingerprint of the context that produced them.
 * That is what makes an AI summary on every record affordable: the model runs
 * when the underlying record has actually changed, not on every page view.
 */
function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}


/**
 * AI is an enhancement, and an enhancement must not be able to take a page down.
 *
 * The daily brief and the record summary render inside server components. A
 * throw in either one fails the whole render: /home and /deals/{id} both
 * returned 500 in production the moment a workspace exhausted its monthly Tiny
 * AI allowance. The CRM data was fine and completely inaccessible — the account
 * that hit it first was the owner's.
 *
 * So nothing below throws on the page path. Every failure — quota, no model
 * configured, provider outage, timeout, malformed output, a database error
 * while caching — becomes a short sentence rendered in place of the summary,
 * and the rest of the page is untouched.
 *
 * `surfaceErrors` is the exception, used by the explicit "regenerate" action.
 * There a person has asked for a summary and is waiting for it, so a plan limit
 * must reach them as an error with an upgrade prompt rather than quietly
 * appearing as prose inside the card.
 */
const AI_TIMEOUT_MS = 12_000;

type Degraded = { body: string; cached: false; model: null; generatedAt: Date; degraded: true };

function degrade(error: unknown): Degraded {
  // The allowance case is separated from every other failure because the user
  // can act on it and nothing is broken: built-in insights still work and the
  // allowance refills. AiAllowanceError is what reserveAiOrThrow raises;
  // PlanLimitError is kept for any other limit that reaches here.
  const body =
    error instanceof AiAllowanceError || error instanceof PlanLimitError
      ? "Tiny AI has used this month's model allowance on your plan, so there is no fresh summary right now. Built-in insights are unaffected, and the allowance resets on the 1st."
      : "Tiny AI could not write a summary just now. Everything else on this page is up to date.";
  return { body, cached: false, model: null, generatedAt: new Date(), degraded: true };
}

/**
 * Did a person ask for this, or did a page render ask on their behalf?
 *
 * `surfaceErrors` is already the flag that means "somebody is waiting for this
 * and must see a real error" — it is set by the explicit regenerate actions in
 * src/lib/actions/ai.ts and by nothing else. Reusing it keeps one notion of
 * who asked, rather than adding a second flag that could disagree with it.
 */
function userAsked(options: { surfaceErrors?: boolean }): boolean {
  return options.surfaceErrors === true;
}

/** A hung provider must not hold a page render open. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tiny AI timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getRecordSummary(
  actor: Actor,
  scope: ContextScope,
  entityType: "contact" | "company" | "deal" | "project" | "opportunity",
  entityId: string,
  options: { force?: boolean; workspaceId: string; surfaceErrors?: boolean } = { workspaceId: "" },
): Promise<{ body: string; cached: boolean; model: string | null; generatedAt: Date } | null> {
  // AI retrieval reads workspace data and is called from pages as well as from
  // actions, so it establishes its own context rather than relying on an ambient
  // one. Under RLS an unscoped read returns nothing, which for AI means a
  // confident answer built from an empty CRM.
  return withTenantContext(scope, async () => {
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

    try {
      // Workspace-aware: a workspace with AI off summarises with the
      // deterministic engine instead of sending its records to a provider.
      let provider = await getProviderForWorkspace(options.workspaceId || scope.workspaceIds[0]!);

      // THE ALLOWANCE IS FOR THINGS THE CUSTOMER ASKED FOR.
      //
      // A page render has not asked for anything. Opening a record used to
      // generate a model-written summary and charge it to the month, and a new
      // Free account measurably read 4 of its allowance before its owner typed
      // a word — on a standing allowance of 10, most of the month spent looking
      // around, with the first question they cared about then refused.
      //
      // So automatic generation uses the built-in engine and is **never
      // metered**. The deterministic summary is a feature rather than a
      // consolation: the settings screen already describes the split as
      // "structured without a model; written in prose with one", and it is
      // computed from the same scores the rest of the page shows.
      //
      // Only `userAsked(options)` — the explicit regenerate action — spends the
      // allowance, and it spends the whole of it, with a real error and an
      // upgrade prompt when it is gone, because somebody is waiting.
      if (provider.id !== "offline") {
        if (userAsked(options)) {
          await reserveAiOrThrow(actor);
        } else {
          provider = offlineProvider();
        }
      }

      const result = await withTimeout(
        provider.complete({
          purpose: "record_summary",
          system: SYSTEM_PROMPTS.recordSummary,
          effort: "low",
          maxTokens: 700,
          messages: [{ role: "user", content: withContext("Summarise this record.", context.text) }],
        }),
        AI_TIMEOUT_MS,
      );


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
    } catch (error) {
      if (options.surfaceErrors) throw error;
      log.warn("record summary unavailable", {
        entityType,
        reason: error instanceof AiAllowanceError ? "ai_allowance" : error instanceof PlanLimitError ? "plan_limit" : "error",
      });
      return degrade(error);
    }
  });
}

export async function getDailyBrief(
  actor: Actor,
  scope: ContextScope,
  options: { force?: boolean; surfaceErrors?: boolean } = {},
): Promise<{ body: string; cached: boolean; model: string | null; generatedAt: Date }> {
  // AI retrieval reads workspace data and is called from pages as well as from
  // actions, so it establishes its own context rather than relying on an ambient
  // one. Under RLS an unscoped read returns nothing, which for AI means a
  // confident answer built from an empty CRM.
  return withTenantContext(scope, async () => {
    const snapshot = await buildWorkspaceSnapshot(scope, { limit: 14 });
    const print = fingerprint(snapshot.text);
    const scopeKey = scope.workspaceIds.slice().sort().join(",");

    if (!options.force) {
      // Asked for by owner. The composed entityId still identifies which scope
      // the brief covers, but who it belongs to is a column now: the old query
      // relied on a string convention to keep one person's brief from another,
      // and a convention is not a boundary.
      const cached = await db.aiInsight.findFirst({
        where: {
          kind: "brief",
          userId: actor.identity.id,
          entityType: "user",
          entityId: `${actor.identity.id}:${scopeKey}`,
          fingerprint: print,
        },
        orderBy: { createdAt: "desc" },
      });
      // Briefs also expire on the hour so "today" stays meaningful even when
      // nothing in the CRM has changed.
      if (cached && Date.now() - cached.createdAt.getTime() < 60 * 60 * 1000) {
        return { body: cached.body, cached: true, model: cached.model, generatedAt: cached.createdAt };
      }
    }

    // A brief can span workspaces, so it uses a provider only when *every*
    // workspace in scope permits transmission. One workspace with AI off is
    // enough to keep the whole brief local — the safe direction.
    const { aiPermission } = await import("@/lib/ai/privacy");
    const permissions = await Promise.all(scope.workspaceIds.map((id) => aiPermission(id)));
    let provider = permissions.every((p) => p.mayTransmitContent)
      ? getProvider()
      : await getProviderForWorkspace(scope.workspaceIds[0] ?? "");

    try {
      // See getRecordSummary. The brief on the home page is not something the
      // customer asked for, so it is built locally and costs nothing; pressing
      // refresh is, and spends one request.
      if (provider.id !== "offline") {
        if (userAsked(options)) {
          await reserveAiOrThrow(actor);
        } else {
          provider = offlineProvider();
        }
      }

      const result = await withTimeout(
        provider.complete({
          purpose: "daily_brief",
          system: SYSTEM_PROMPTS.dailyBrief,
          effort: "medium",
          maxTokens: 1100,
          messages: [
            {
              role: "user",
              content: withContext(
                `Write my brief. Today is ${new Date().toDateString()}. My name is ${actor.identity.name.split(" ")[0]}.`,
                snapshot.text,
              ),
            },
          ],
        }),
        AI_TIMEOUT_MS,
      );


      const workspaceId = scope.workspaceIds[0];
      if (workspaceId) {
        await db.aiInsight.deleteMany({
          where: {
            kind: "brief",
            userId: actor.identity.id,
            entityType: "user",
            entityId: `${actor.identity.id}:${scopeKey}`,
          },
        });
        await db.aiInsight.create({
          data: {
            workspaceId,
            userId: actor.identity.id,
            kind: "brief",
            entityType: "user",
            entityId: `${actor.identity.id}:${scopeKey}`,
            title: "Daily brief",
            body: result.text,
            model: `${result.provider}:${result.model}`,
            fingerprint: print,
          },
        });
      }

      return { body: result.text, cached: false, model: result.model, generatedAt: new Date() };
    } catch (error) {
      if (options.surfaceErrors) throw error;
      // /home is the screen a signed-in person lands on. It renders without a
      // brief far more gracefully than it renders a 500.
      log.warn("daily brief unavailable", {
        reason: error instanceof AiAllowanceError ? "ai_allowance" : error instanceof PlanLimitError ? "plan_limit" : "error",
      });
      return degrade(error);
    }
  });
}

async function resolveWorkspaceId(entityType: string, entityId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = await (db as any)[entityType].findUnique({
    where: { id: entityId },
    select: { workspaceId: true },
  });
  return record?.workspaceId ?? null;
}
