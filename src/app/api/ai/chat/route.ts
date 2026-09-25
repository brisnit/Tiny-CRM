import { z } from "zod";

import { getActor, resolveReadScope, restrictedIdsFor } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { askTinyAi, ensureThread } from "@/lib/ai/crm-agent";
import { requireFlag } from "@/lib/flags";
import { AppError, toAppError } from "@/lib/errors";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";
import { enforceRateLimit } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/validation/limits";
import { zId, zScope } from "@/lib/validation/common";

/**
 * Tiny AI chat.
 *
 * The authorization order here is the point of the whole AI design:
 *
 *   authenticate → authorise the workspace → retrieve permitted context →
 *   minimise it → send to the model
 *
 * The model never chooses what it may read. If a `focus` record is supplied it
 * is resolved through `requireWorkspaceAccess`, so a caller cannot point the
 * assistant at another tenant's record and have it summarised back to them.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  question: z.string().trim().min(1, "Ask a question").max(LIMITS.maxAiQuestion),
  scope: zScope.optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(LIMITS.maxAiQuestion),
      }),
    )
    .max(LIMITS.maxAiHistoryTurns)
    .optional(),
  focus: z
    .object({
      type: z.enum(["contact", "company", "deal", "project", "opportunity", "fileAsset"]),
      id: zId,
    })
    .nullish(),
});

/**
 * The document question path.
 *
 * Kept out of POST so the ordering that matters is readable in one place:
 *
 *   authorise the file (already done) -> three gates -> retrieve -> decide
 *
 * The decision is the point. With no passages this returns the deterministic
 * unsupported answer and **never resolves a provider**, so there is no model
 * call to answer from general knowledge. With passages it streams, and appends
 * citations the application built from stored page provenance.
 */
async function answerAboutDocument(input: {
  actor: Awaited<ReturnType<typeof getActor>>;
  workspaceId: string;
  fileAssetId: string;
  question: string;
  requestId: string;
}): Promise<Response> {
  const { retrievePassages } = await import("@/lib/documents/retrieve");
  const { answerFromDocument, unsupportedAnswer } = await import("@/lib/ai/document-agent");
  const { restrictedIdsFor } = await import("@/lib/auth/access");
  const { withTenantContext } = await import("@/lib/tenant-db");
  const { assertWithinLimit, recordUsage } = await import("@/lib/entitlements");
  const actor = input.actor!;

  // The same monthly entitlement the CRM agent enforces. Without this the
  // document path would be a way around the plan's AI allowance: a paid limit
  // that one endpoint checks and another does not is not a limit.
  await assertWithinLimit(actor, "aiRequestsPerMonth");

  const scope = {
    workspaceIds: [input.workspaceId],
    userId: actor.identity.id,
    restrictedWorkspaceIds: restrictedIdsFor(actor.memberships, [input.workspaceId]),
  };

  // Retrieval — and the three gates it asserts — inside the context this
  // request earned from its own memberships.
  const { result, fileName } = await withTenantContext(scope, async () => {
    const retrieved = await retrievePassages({
      fileAssetId: input.fileAssetId,
      workspaceId: input.workspaceId,
      question: input.question,
    });
    // The filename for a citation or a refusal. Read here, under the same
    // context, rather than trusted from anywhere.
    const { db } = await import("@/lib/db");
    const file = await db.fileAsset.findFirst({
      where: { id: input.fileAssetId, workspaceId: input.workspaceId },
      select: { name: true },
    });
    return { result: retrieved, fileName: file?.name ?? "this document" };
  });

  const textHeaders = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "x-request-id": input.requestId,
  };

  // THE REFUSAL INVARIANT. No provider is resolved on this path.
  if (result.passages.length === 0) {
    log.info("document question unsupported", {
      reason: result.reason,
      corpusChunks: result.corpus.chunks,
    });
    return new Response(unsupportedAnswer(fileName, result), { status: 200, headers: textHeaders });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of answerFromDocument({
          workspaceId: input.workspaceId,
          fileName,
          question: input.question,
          result,
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
        // Recorded only when a provider was actually called. A refusal costs
        // nothing, so it does not spend the allowance; the rate limiter is what
        // bounds a caller asking unanswerable questions in a loop.
        await recordUsage(actor.identity.id, "ai_requests");
      } catch (raw) {
        const error = toAppError(raw);
        if (error.category === "internal") {
          log.error("document answer failed", { error: String(error.internal) });
        }
        controller.enqueue(encoder.encode(`\n\n⚠ ${error.message}`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...textHeaders, "X-Accel-Buffering": "no" },
  });
}

export async function POST(request: Request) {
  const requestId = newRequestId();

  return runWithContext({ requestId, route: "api.ai.chat" }, async () => {
    try {
      const actor = await getActor();
      if (!actor) return new Response("Unauthorized", { status: 401 });

      // Two windows: a burst limit and an hourly ceiling. AI requests cost real
      // money, so an authenticated user must not be able to spend without bound.
      await enforceRateLimit("ai", { user: actor.identity.id });
      await enforceRateLimit("aiHourly", { user: actor.identity.id });

      const body = bodySchema.parse(await request.json());

      const read = await resolveReadScope(body.scope ?? "all");
  const { memberships } = read;

      // Only workspaces where this role may use AI contribute context.
      const permitted = memberships.filter((m) => can(m.role, "ai:use")).map((m) => m.id);
      const readable = read.workspaceIds.filter((id) => permitted.includes(id));
      if (readable.length === 0) {
        throw new AppError("forbidden", "Your role cannot use Tiny AI.");
      }

      /**
       * The flag, read where this request is allowed to see it.
       *
       * `FeatureFlag` is workspace-scoped and under row-level security, so a
       * workspace override is only visible while `app.workspace_ids` is set.
       * Read with no context it is filtered out and `isEnabled` falls back to
       * the built-in default — and for `ai` that default is `true`, so a
       * workspace that had deliberately switched Tiny AI off kept getting it.
       *
       * The context is the one this request has already earned: `readable` is
       * the caller's own memberships filtered by `ai:use`, and the focused
       * branch names a workspace `requireRecordAccess` just resolved under RLS.
       * Neither grants anything new. `isEnabled` is deliberately left alone —
       * teaching it to open a context from a caller-supplied id would let any
       * caller read another workspace's overrides, which is the boundary this
       * policy exists to hold.
       */
      const flagInContext = (workspaceIds: string[], forWorkspace: string | null) =>
        withTenantContext(
          {
            workspaceIds,
            userId: actor.identity.id,
            restrictedWorkspaceIds: restrictedIdsFor(actor.memberships, workspaceIds),
          },
          () => requireFlag("ai", forWorkspace),
        );

      // A focused record is authorised on its own terms before retrieval.
      if (body.focus) {
        const { requireRecordAccess } = await import("@/lib/auth/access");
        const { workspaceId } = await requireRecordAccess(body.focus.type, body.focus.id, {
          permission: "ai:use",
        });
        await flagInContext([workspaceId], workspaceId);

        /**
         * Asking about a document.
         *
         * Separate from the CRM path because the grounding rules are different:
         * the answer may come only from the document, the citations are built
         * from stored page provenance, and an unsupported question must not
         * reach a model at all.
         *
         * The workspace is the one `requireRecordAccess` just resolved from the
         * FileAsset — never a caller-supplied id. `body.focus.id` is the only
         * thing the request contributed, and it was authorised above with
         * `ai:use`, so a viewer never gets here and a foreign id is already a
         * "no such record".
         */
        if (body.focus.type === "fileAsset") {
          return await answerAboutDocument({
            actor,
            workspaceId,
            fileAssetId: body.focus.id,
            question: body.question,
            requestId,
          });
        }
      } else {
        // Unchanged behaviour for the multi-workspace case: with more than one
        // readable workspace there is no single override to consult, so only a
        // global row applies. Widening that is a product decision, not part of
        // this fix.
        await flagInContext(readable, readable.length === 1 ? readable[0]! : null);
      }

      // Rebuilt rather than passed through: narrowing `focus.type` does not
      // narrow `focus` itself, and widening the CRM agent's focus type to a case
      // it does not handle would be the wrong fix.
      const focused = body.focus ?? null;
      const crmFocus =
        focused && focused.type !== "fileAsset"
          ? { type: focused.type, id: focused.id }
          : null;

      const scope = {
        workspaceIds: readable,
        userId: actor.identity.id,
    restrictedWorkspaceIds: restrictedIdsFor(actor.memberships, readable),
        workspaceNames: new Map(memberships.map((m) => [m.id, m.name])),
      };

      const thread = await ensureThread(
        actor.identity.id,
        readable.length === 1 ? readable[0]! : null,
        body.question,
      );

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of askTinyAi({
              actor,
              scope,
              question: body.question,
              history: body.history,
              // Narrowed deliberately: the fileAsset branch above returned, so
              // this can only be a CRM record. Stating it here keeps the CRM
              // agent's focus type unchanged rather than widening it to a case
              // it does not handle.
              focus: crmFocus,
              threadId: thread.id,
            })) {
              controller.enqueue(encoder.encode(chunk));
            }
          } catch (raw) {
            // The stream has already begun, so errors are appended as text
            // rather than as a status code — but they are still the safe,
            // categorised message, never an internal one.
            const error = toAppError(raw);
            if (error.category === "internal") {
              log.error("ai stream failed", { error: String(error.internal) });
            }
            controller.enqueue(encoder.encode(`\n\n⚠ ${error.message}`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
          "x-request-id": requestId,
        },
      });
    } catch (raw) {
      const error = toAppError(raw);
      if (error.category === "internal") {
        log.error("ai chat failed", { error: String(error.internal) });
      }
      return Response.json(
        { error: error.message, category: error.category, requestId },
        { status: error.status, headers: { "x-request-id": requestId } },
      );
    }
  });
}
