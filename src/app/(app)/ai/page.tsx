import Link from "next/link";
import { Sparkles } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { AskAiButton } from "@/components/app/ask-ai-button";
import { CleanupList } from "@/components/app/cleanup-list";
import { CaptureWithAi } from "@/components/app/capture-with-ai";
import { requireUser, resolveScope, getUserWorkspaces } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { findRecommendations } from "@/lib/ai/recommendations";
import { describeProvider, isModelBacked } from "@/lib/ai/provider";
import { SUGGESTED_QUESTIONS } from "@/lib/ai/crm-agent";

export const metadata = { title: "Tiny AI" };

export default async function AiPage() {
  const user = await requireUser();
  const { workspaceIds, workspaceId } = await resolveScope(user.id, await readScope());
  const workspaces = await getUserWorkspaces(user.id);

  const recommendations = await findRecommendations({
    workspaceIds,
    workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])),
  });

  const provider = describeProvider();
  const grouped = {
    high: recommendations.filter((r) => r.severity === "high"),
    medium: recommendations.filter((r) => r.severity === "medium"),
    low: recommendations.filter((r) => r.severity === "low"),
  };

  return (
    <PageShell>
      <PageHeader
        title="Tiny AI"
        description="Ask about your business, and keep the CRM honest."
        actions={<AskAiButton label="Open Tiny AI" variant="brand" />}
      />

      <div className="space-y-5">
        <CaptureWithAi
          workspaceId={workspaceId}
          workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
        />

        <Panel>
          <PanelHeader
            title="Ask anything"
            description={provider.label}
            icon={<Sparkles />}
          />
          <div className="grid gap-px border-t border-hairline bg-hairline sm:grid-cols-2">
            {SUGGESTED_QUESTIONS.map((question) => (
              <div key={question} className="bg-panel">
                <AskAiQuestion question={question} />
              </div>
            ))}
          </div>
          {!isModelBacked() ? (
            <p className="border-t border-hairline px-4 py-3 text-[12px] leading-relaxed text-muted">
              Running the built-in reasoning engine. It answers these questions exactly, from the same computed
              scores the rest of the app uses.{" "}
              <Link href="/settings/ai" className="text-brand-600 hover:underline dark:text-brand-400">
                Connect a model
              </Link>{" "}
              for open-ended questions.
            </p>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader
            title="CRM cleanup"
            description={
              recommendations.length === 0
                ? "Nothing needs tidying"
                : `${recommendations.length} thing${recommendations.length === 1 ? "" : "s"} worth a look`
            }
            action={
              grouped.high.length > 0 ? (
                <Badge tone="bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900">
                  {grouped.high.length} urgent
                </Badge>
              ) : null
            }
          />
          {recommendations.length === 0 ? (
            <div className="border-t border-hairline">
              <EmptyState
                compact
                title="Your CRM is clean"
                description="No duplicates, no stale deals, no overdue follow-ups. That is unusual — enjoy it."
              />
            </div>
          ) : (
            <CleanupList
              recommendations={recommendations.map((r) => ({
                id: r.id,
                kind: r.kind,
                severity: r.severity,
                title: r.title,
                detail: r.detail,
                entityType: r.entityType,
                entityIds: r.entityIds,
                action: r.action,
              }))}
              workspaceId={workspaceId ?? workspaceIds[0]!}
            />
          )}
        </Panel>

        <Panel>
          <PanelHeader title="What Tiny AI does not do" />
          <ul className="space-y-2.5 border-t border-hairline p-4">
            {[
              "It never edits your CRM without you approving the change first.",
              "It only reads workspaces you already have access to — scoping happens before the model is called.",
              "It does not invent numbers. Scores and risk calls are computed by the app; the model explains them.",
              "It tells you when it does not know something, rather than filling the gap.",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-muted">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </PageShell>
  );
}

function AskAiQuestion({ question }: { question: string }) {
  return (
    <div className="p-1">
      <AskAiButton question={question} label={question} variant="ghost" size="sm" />
    </div>
  );
}
