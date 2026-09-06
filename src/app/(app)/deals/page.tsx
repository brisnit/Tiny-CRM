import { Suspense } from "react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { PipelineBoard, EmptyBoard } from "@/components/app/pipeline-board";
import { PipelinePicker } from "@/components/app/pipeline-picker";
import { StatRow, StatTile } from "@/components/app/stat-tile";
import { Panel, Skeleton } from "@/components/ui/surface";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readProjectFocus, readScope } from "@/lib/scope";
import { getPipelineBoard } from "@/lib/data/deals";
import { formatCompact } from "@/lib/money";

export const metadata = { title: "Deals" };

export default async function DealsPage({ searchParams }: PageProps<"/deals">) {
  return (
    <PageShell wide>
      <PageHeader
        title="Deals"
        description="Drag a deal to move it. Momentum and win probability update as you go."
        actions={<NewRecordButton kind="deal" label="New deal" />}
      />
      <Suspense fallback={<BoardSkeleton />}>
        <Board searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function Board({ searchParams }: { searchParams: PageProps<"/deals">["searchParams"] }) {
  const params = await searchParams;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const projectFocus = await readProjectFocus();

  const board = await getPipelineBoard(workspaceIds, {
    pipelineId: typeof params.pipeline === "string" ? params.pipeline : undefined,
    projectId: projectFocus ?? undefined,
    kind: "deal",
  });

  if (!board.active) {
    return (
      <Panel>
        <EmptyBoard label="pipeline" />
      </Panel>
    );
  }

  const won = board.columns.find((c) => c.stage.kind === "won");
  const lost = board.columns.find((c) => c.stage.kind === "lost");
  const closed = (won?.count ?? 0) + (lost?.count ?? 0);
  const winRate = closed > 0 ? Math.round(((won?.count ?? 0) / closed) * 100) : null;

  return (
    <div className="space-y-4">
      <PipelinePicker
        pipelines={board.pipelines.map((p) => ({
          id: p.id,
          name: p.name,
          workspaceName: p.workspace.name,
          isDefault: p.isDefault,
        }))}
        activeId={board.active.id}
      />

      <StatRow className="lg:grid-cols-4">
        <StatTile
          label="Open pipeline"
          value={formatCompact(board.totals.valueCents)}
          hint={`${board.totals.count} deal${board.totals.count === 1 ? "" : "s"}`}
          tone="brand"
        />
        <StatTile
          label="Weighted forecast"
          value={formatCompact(board.totals.forecastCents)}
          hint="Value × win probability"
        />
        <StatTile
          label="Won"
          value={formatCompact(won?.valueCents ?? 0)}
          hint={`${won?.count ?? 0} closed won`}
        />
        <StatTile
          label="Win rate"
          value={winRate === null ? "—" : `${winRate}%`}
          hint={closed > 0 ? `${closed} closed deals` : "No closed deals yet"}
        />
      </StatRow>

      <PipelineBoard columns={board.columns} kind="deal" href="/deals" />
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="w-[286px] shrink-0 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}
