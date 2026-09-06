import { z } from "zod";

import { getActor, resolveReadScope } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { askTinyAi, ensureThread } from "@/lib/ai/crm-agent";
import { requireFlag } from "@/lib/flags";
import { AppError, toAppError } from "@/lib/errors";
import { log, newRequestId, runWithContext } from "@/lib/logger";
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
      type: z.enum(["contact", "company", "deal", "project", "opportunity"]),
      id: zId,
    })
    .nullish(),
});

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

      const { workspaceIds, memberships } = await resolveReadScope(body.scope ?? "all");

      // Only workspaces where this role may use AI contribute context.
      const permitted = memberships.filter((m) => can(m.role, "ai:use")).map((m) => m.id);
      const readable = workspaceIds.filter((id) => permitted.includes(id));
      if (readable.length === 0) {
        throw new AppError("forbidden", "Your role cannot use Tiny AI.");
      }

      // A focused record is authorised on its own terms before retrieval.
      if (body.focus) {
        const { requireRecordAccess } = await import("@/lib/auth/access");
        const { workspaceId } = await requireRecordAccess(body.focus.type, body.focus.id, {
          permission: "ai:use",
        });
        await requireFlag("ai", workspaceId);
      } else {
        await requireFlag("ai", readable.length === 1 ? readable[0] : null);
      }

      const scope = {
        workspaceIds: readable,
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
              focus: body.focus ?? null,
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
