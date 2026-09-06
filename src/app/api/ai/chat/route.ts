import { getCurrentUser, getUserWorkspaces, resolveScope } from "@/lib/auth/session";
import { askTinyAi, ensureThread } from "@/lib/ai/crm-agent";
import { PlanLimitError } from "@/lib/plans";

export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const body = (await request.json()) as {
    question?: string;
    scope?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    focus?: { type: "contact" | "company" | "deal" | "project" | "opportunity"; id: string } | null;
  };

  const question = body.question?.trim();
  if (!question) return new Response("Ask a question", { status: 400 });

  const { workspaceIds } = await resolveScope(user.id, body.scope);
  const workspaces = await getUserWorkspaces(user.id);
  const scope = {
    workspaceIds,
    workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])),
  };

  const thread = await ensureThread(user.id, workspaceIds.length === 1 ? workspaceIds[0]! : null, question);

  // Streamed as plain text so the client can append tokens directly; the
  // provider abstraction makes the same route work for every backend.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of askTinyAi({
          user,
          scope,
          question,
          history: body.history,
          focus: body.focus ?? null,
          threadId: thread.id,
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (error) {
        const message =
          error instanceof PlanLimitError
            ? `\n\n⚠ ${error.message}`
            : "\n\n⚠ Tiny AI could not finish that request. Please try again.";
        if (!(error instanceof PlanLimitError)) console.error("[ai/chat]", error);
        controller.enqueue(encoder.encode(message));
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
    },
  });
}
