import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { PipelineManager } from "@/components/app/pipeline-manager";
import { requireActor } from "@/lib/auth/access";
import { db } from "@/lib/db";
import { PIPELINE_KIND } from "@/lib/enums";

export const metadata = { title: "Pipelines" };

export default async function PipelineSettings() {
  const actor = await requireActor();
  const workspaces = actor.memberships;

  const pipelines = await db.pipeline.findMany({
    where: { workspaceId: { in: workspaces.map((w) => w.id) } },
    select: {
      id: true, name: true, kind: true, description: true, isDefault: true, workspaceId: true,
      stages: {
        select: { id: true, name: true, probability: true, color: true, kind: true, order: true },
        orderBy: { order: "asc" },
      },
      _count: { select: { deals: true, opportunities: true } },
    },
    orderBy: [{ workspaceId: "asc" }, { order: "asc" }],
  });

  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-muted">
        Each business can run as many pipelines as it needs — Sales, RFP Opportunities, Partnerships, Investors,
        Hiring. Stages carry a base win rate, which Tiny CRM adjusts by momentum when it forecasts.
      </p>

      {workspaces.map((workspace) => (
        <div key={workspace.id} className="space-y-3">
          <h2 className="flex items-center gap-2 px-1 text-[13px] font-semibold text-body">
            <span className="size-2.5 rounded-full" style={{ background: workspace.color }} />
            {workspace.name}
          </h2>

          {pipelines
            .filter((p) => p.workspaceId === workspace.id)
            .map((pipeline) => (
              <Panel key={pipeline.id}>
                <PanelHeader
                  title={pipeline.name}
                  description={pipeline.description}
                  action={
                    <div className="flex items-center gap-1.5">
                      <Badge tone={PIPELINE_KIND.tone(pipeline.kind)}>{PIPELINE_KIND.label(pipeline.kind)}</Badge>
                      {pipeline.isDefault ? <Badge>Default</Badge> : null}
                      <span className="text-[11.5px] text-faint tabular">
                        {pipeline._count.deals + pipeline._count.opportunities} records
                      </span>
                    </div>
                  }
                />
                <div className="border-t border-hairline">
                  <ul className="divide-y divide-hairline">
                    {pipeline.stages.map((stage) => (
                      <li key={stage.id} className="flex items-center gap-3 px-4 py-2">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: stage.color }} />
                        <span className="min-w-0 flex-1 text-[13px] text-body">{stage.name}</span>
                        {stage.kind !== "open" ? (
                          <Badge
                            tone={
                              stage.kind === "won"
                                ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900"
                                : "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900"
                            }
                          >
                            {stage.kind}
                          </Badge>
                        ) : null}
                        <span className="w-12 shrink-0 text-right text-[12px] text-faint tabular">
                          {stage.probability}%
                        </span>
                      </li>
                    ))}
                  </ul>
                  <PipelineManager pipelineId={pipeline.id} />
                </div>
              </Panel>
            ))}

          <PipelineManager workspaceId={workspace.id} createPipeline />
        </div>
      ))}
    </div>
  );
}
