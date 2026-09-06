import { Suspense } from "react";
import { BarChart3 } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel, PanelHeader, Skeleton } from "@/components/ui/surface";
import { RangePicker } from "@/components/app/range-picker";
import {
  DealFlowTrend, HeroNumber, MagnitudeBars, PipelineFunnel, RevenueTrend,
} from "@/components/app/charts";
import { requireUser, resolveScope } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { getAnalytics, type AnalyticsRange } from "@/lib/data/analytics";
import { formatCompact, formatMoney } from "@/lib/money";
import { LEAD_SOURCE } from "@/lib/enums";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  return (
    <PageShell wide>
      <PageHeader
        title="Analytics"
        description="Where the revenue comes from, and how fast it moves."
        actions={<RangePicker />}
      />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <Report searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function Report({ searchParams }: { searchParams: PageProps<"/analytics">["searchParams"] }) {
  const params = await searchParams;
  const user = await requireUser();
  const { workspaceIds } = await resolveScope(user.id, await readScope());

  const rangeParam = Number(typeof params.range === "string" ? params.range : 90);
  const range = ([30, 90, 180, 365].includes(rangeParam) ? rangeParam : 90) as AnalyticsRange;

  const data = await getAnalytics(workspaceIds, range);
  const rangeLabel =
    range === 30 ? "last 30 days" : range === 90 ? "last 90 days" : range === 180 ? "last 6 months" : "last year";

  return (
    <div className="space-y-5">
      {/* Headline figures. Not every number deserves a chart. */}
      <div className="grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-panel">
          <HeroNumber
            label="Open pipeline"
            value={formatCompact(data.pipeline.valueCents)}
            caption={`${data.pipeline.count} open deal${data.pipeline.count === 1 ? "" : "s"}, averaging ${formatCompact(data.pipeline.avgDealCents)}`}
            tone="brand"
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Revenue won"
            value={formatCompact(data.won.valueCents)}
            caption={`${data.won.count} deal${data.won.count === 1 ? "" : "s"} closed in the ${rangeLabel}`}
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Win rate"
            value={data.winRate === null ? "—" : `${data.winRate}%`}
            caption={
              data.winRate === null
                ? "No deals have closed in this window yet"
                : `${data.won.count} won and ${data.lost.count} lost`
            }
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Sales cycle"
            value={data.avgCycleDays === null ? "—" : `${data.avgCycleDays}d`}
            caption={
              data.avgCycleDays === null
                ? "Needs at least one closed-won deal"
                : "Average from creation to close"
            }
          />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Revenue won by month"
            description={`Closed-won value, ${rangeLabel}`}
            icon={<BarChart3 />}
          />
          <div className="border-t border-hairline p-4">
            <RevenueTrend data={data.months.map((m) => ({ month: m.month, wonCents: m.wonCents }))} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Deal flow" description="Deals created against deals won" />
          <div className="border-t border-hairline p-4">
            <DealFlowTrend
              data={data.months.map((m) => ({
                month: m.month,
                createdCount: m.createdCount,
                wonCount: m.wonCount,
              }))}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Open pipeline by stage"
            description="Where the value is sitting right now"
          />
          <div className="border-t border-hairline p-4">
            <PipelineFunnel data={data.funnel} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Lead sources" description={`Deals created in the ${rangeLabel}`} />
          <div className="border-t border-hairline p-4">
            <MagnitudeBars
              format="count"
              valueLabel="Deals created"
              emptyLabel="No deals created in this window"
              data={data.leadSources.map((row) => ({
                name: LEAD_SOURCE.label(row.source, "Unknown"),
                value: row.count,
                secondary: row.valueCents > 0 ? formatCompact(row.valueCents) : undefined,
              }))}
            />
          </div>
        </Panel>
      </div>

      <div className="grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-panel">
          <HeroNumber
            label="Deals created"
            value={String(data.dealsCreated)}
            caption={`${data.contactsAdded} contact${data.contactsAdded === 1 ? "" : "s"} added in the same window`}
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Average deal size"
            value={data.won.avgDealCents > 0 ? formatCompact(data.won.avgDealCents) : "—"}
            caption={data.won.count > 0 ? `Across ${data.won.count} closed-won deals` : "No closed-won deals yet"}
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Projects"
            value={String(data.projects.active)}
            caption={`${data.projects.completed} completed · ${formatMoney(data.projects.revenueCents)} recorded revenue`}
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Opportunity value"
            value={formatCompact(data.opportunities.valueCents)}
            caption={`${data.opportunities.count} opportunit${data.opportunities.count === 1 ? "y" : "ies"} in flight`}
          />
        </div>
      </div>

      <div className="grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2">
        <div className="bg-panel">
          <HeroNumber
            label="Tasks completed"
            value={String(data.tasks.completed)}
            caption={`In the ${rangeLabel}`}
          />
        </div>
        <div className="bg-panel">
          <HeroNumber
            label="Overdue tasks"
            value={String(data.tasks.overdue)}
            tone={data.tasks.overdue > 0 ? "warn" : "default"}
            caption={data.tasks.overdue > 0 ? "Worth clearing before they compound" : "Nothing overdue"}
          />
        </div>
      </div>

      {/* The table view: every figure above, readable without colour. */}
      <Panel>
        <PanelHeader title="Figures" description="The same numbers, as a table" />
        <div className="overflow-x-auto border-t border-hairline">
          <table className="w-full text-[13px]">
            <thead className="border-b border-hairline bg-sunken/40">
              <tr>
                <th scope="col" className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-faint">
                  Month
                </th>
                <th scope="col" className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-faint">
                  Created
                </th>
                <th scope="col" className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-faint">
                  Won
                </th>
                <th scope="col" className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-faint">
                  Lost
                </th>
                <th scope="col" className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-faint">
                  Revenue
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {data.months.map((month) => (
                <tr key={month.month}>
                  <td className="px-4 py-2 text-body">{formatMonth(month.month)}</td>
                  <td className="px-4 py-2 text-right tabular text-muted">{month.createdCount}</td>
                  <td className="px-4 py-2 text-right tabular text-muted">{month.wonCount}</td>
                  <td className="px-4 py-2 text-right tabular text-muted">{month.lostCount}</td>
                  <td className="px-4 py-2 text-right font-medium tabular text-body">
                    {formatMoney(month.wonCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function formatMonth(key: string) {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
