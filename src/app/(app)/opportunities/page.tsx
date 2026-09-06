import Link from "next/link";
import { Suspense } from "react";
import { AlertTriangle, Landmark, ThumbsDown, ThumbsUp } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { FilterBar } from "@/components/app/filter-bar";
import { Panel, Skeleton } from "@/components/ui/surface";
import { StatRow, StatTile } from "@/components/app/stat-tile";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireUser, resolveScope } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { listOpportunities } from "@/lib/data/opportunities";
import { formatCompact, formatMoney } from "@/lib/money";
import { describeDeadline, formatDay } from "@/lib/dates";
import {
  COMPETITION_LEVEL, OPPORTUNITY_TYPE, STRATEGIC_VALUE, SUBMISSION_STATUS, TONE,
} from "@/lib/enums";

export const metadata = { title: "Opportunities" };

export default async function OpportunitiesPage({ searchParams }: PageProps<"/opportunities">) {
  return (
    <PageShell wide>
      <PageHeader
        title="Opportunities"
        description="RFPs, grants and partnerships — with the deadlines and the go / no-go call."
        actions={<NewRecordButton kind="opportunity" label="Track opportunity" />}
      />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <OpportunityList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function OpportunityList({
  searchParams,
}: {
  searchParams: PageProps<"/opportunities">["searchParams"];
}) {
  const params = await searchParams;
  const user = await requireUser();
  const { workspaceIds } = await resolveScope(user.id, await readScope());
  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);

  const opportunities = await listOpportunities(workspaceIds, {
    q: str("q"),
    type: str("type"),
    submissionStatus: str("submissionStatus"),
    view: str("view") ?? "open",
  });

  const openOnes = opportunities.filter((o) => !["won", "lost", "no_bid"].includes(o.submissionStatus));
  const totalValue = openOnes.reduce((sum, o) => sum + (o.estimatedValueCents ?? 0), 0);
  const goCount = openOnes.filter((o) => o.assessment.recommendation === "go").length;
  const urgent = openOnes.filter((o) => {
    const d = describeDeadline(o.deadlineAt);
    return d.urgent || d.overdue;
  }).length;

  return (
    <div className="space-y-4">
      <StatRow className="lg:grid-cols-4">
        <StatTile
          label="In flight"
          value={openOnes.length}
          hint={`${opportunities.length} tracked in total`}
        />
        <StatTile label="Total value" value={formatCompact(totalValue)} hint="Estimated" tone="brand" />
        <StatTile label="Recommended go" value={goCount} hint="Strong fit and odds" />
        <StatTile
          label="Deadline pressure"
          value={urgent}
          hint={urgent > 0 ? "Due within a week" : "Nothing urgent"}
          tone={urgent > 0 ? "warn" : "default"}
        />
      </StatRow>

      <FilterBar
        searchPlaceholder="Search opportunities and requirements…"
        views={[
          { value: "open", label: "In flight" },
          { value: "due_soon", label: "Due in 30 days" },
          { value: "submitted", label: "Submitted" },
          { value: "all", label: "All" },
        ]}
        filters={[
          { key: "type", label: "Type", options: OPPORTUNITY_TYPE.options },
          { key: "submissionStatus", label: "Status", options: SUBMISSION_STATUS.options },
        ]}
      />

      {opportunities.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Landmark />}
            title="No opportunities tracked"
            description="RFPs, grants and partnership openings get deadlines, requirements and a go / no-go recommendation."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {opportunities.map((opp) => {
            const deadline = describeDeadline(opp.deadlineAt);
            const questions = describeDeadline(opp.questionsDeadlineAt);
            const rec = opp.assessment.recommendation;

            return (
              <Link
                key={opp.id}
                href={`/opportunities/${opp.id}`}
                className="block rounded-xl border border-hairline bg-panel p-4 transition-colors hover:border-hairline-strong"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-body">{opp.name}</h3>
                      <Badge tone={OPPORTUNITY_TYPE.tone(opp.type)}>{OPPORTUNITY_TYPE.label(opp.type)}</Badge>
                      <Badge tone={SUBMISSION_STATUS.tone(opp.submissionStatus)}>
                        {SUBMISSION_STATUS.label(opp.submissionStatus)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted">
                      {[opp.company?.name, opp.solicitationNumber, opp.source].filter(Boolean).join(" · ") ||
                        "No organization"}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 text-right">
                    <div>
                      <div className="text-[15px] font-semibold tabular text-body">
                        {formatMoney(opp.estimatedValueCents)}
                      </div>
                      <div className="text-[11px] text-faint">Estimated value</div>
                    </div>
                    <Badge tone={recTone(rec)} className="shrink-0 px-2 py-1">
                      {rec === "go" || rec === "lean_go" ? (
                        <ThumbsUp className="size-3" />
                      ) : (
                        <ThumbsDown className="size-3" />
                      )}
                      {recLabel(rec)}
                    </Badge>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-hairline pt-3 text-[12px]">
                  <span
                    className={
                      deadline.overdue
                        ? "font-medium text-rose-600 dark:text-rose-400"
                        : deadline.urgent
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : "text-muted"
                    }
                  >
                    {opp.proposalDeadlineAt ? "Proposal " : "Deadline "}
                    {formatDay(opp.deadlineAt, "not set")} · {deadline.label}
                  </span>
                  {opp.questionsDeadlineAt ? (
                    <span className={questions.urgent ? "font-medium text-amber-600 dark:text-amber-400" : "text-faint"}>
                      Questions {formatDay(opp.questionsDeadlineAt)}
                    </span>
                  ) : null}
                  {opp.fitScore !== null ? (
                    <span className="text-faint">Fit {opp.fitScore}/100</span>
                  ) : null}
                  {opp.strategicValue ? (
                    <span className="text-faint">
                      {STRATEGIC_VALUE.label(opp.strategicValue)} strategic value
                    </span>
                  ) : null}
                  {opp.competitionLevel ? (
                    <span className="text-faint">
                      {COMPETITION_LEVEL.label(opp.competitionLevel)} competition
                    </span>
                  ) : null}
                  <span className="ml-auto text-faint">
                    {opp._count.tasks} task{opp._count.tasks === 1 ? "" : "s"} · {opp._count.contacts} contact
                    {opp._count.contacts === 1 ? "" : "s"}
                  </span>
                </div>

                {opp.assessment.reasons[0] && opp.assessment.reasons[0].impact < 0 ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    {opp.assessment.reasons[0].detail}
                  </p>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function recLabel(rec: string) {
  return { go: "Go", lean_go: "Lean go", lean_no: "Lean no", no_bid: "No bid" }[rec] ?? rec;
}

function recTone(rec: string) {
  return (
    { go: TONE.green, lean_go: TONE.brand, lean_no: TONE.amber, no_bid: TONE.rose }[rec] ?? TONE.neutral
  );
}
