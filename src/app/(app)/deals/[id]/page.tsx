import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle, CalendarDays, CheckSquare, FileText, Paperclip, TrendingUp, Users,
} from "lucide-react";

import { PageHeader, PageShell, MetaItem } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/controls";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { ActivityFeed } from "@/components/app/activity-feed";
import { TimelineComposer } from "@/components/app/timeline-composer";
import { AiSummaryCard } from "@/components/app/ai-summary-card";
import { ScoreExplainer } from "@/components/app/score-explainer";
import { AskAiButton } from "@/components/app/ask-ai-button";
import { RelatedList } from "@/components/app/related-list";
import { TaskRow } from "@/components/app/task-row";
import { RecordHeaderActions } from "@/components/app/record-edit";
import { StageSelector } from "@/components/app/stage-selector";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { getDeal } from "@/lib/data/deals";
import { getEditContext } from "@/lib/data/shell";
import { getRecordSummary } from "@/lib/ai/summaries";
import { describeProvider } from "@/lib/ai/provider";
import { formatMoney } from "@/lib/money";
import { formatDate, formatDay, timeAgo, daysSince } from "@/lib/dates";
import { LEAD_SOURCE, TONE } from "@/lib/enums";

export async function generateMetadata({ params }: PageProps<"/deals/[id]">) {
  const { id } = await params;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const deal = await getDeal(workspaceIds, id);
  return { title: deal?.name ?? "Deal" };
}

export default async function DealPage({ params }: PageProps<"/deals/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const deal = await getDeal(workspaceIds, id);
  if (!deal) notFound();

  const workspaces = actor.memberships;
  const summary = await getRecordSummary(
    actor,
    { workspaceIds, workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])) },
    "deal",
    id,
    { workspaceId: deal.workspaceId },
  );

  const editContext = await getEditContext(actor, [deal.workspaceId]);

  const daysInStage = daysSince(deal.stageEnteredAt) ?? 0;

  return (
    <PageShell wide>
      <PageHeader
        backHref="/deals"
        backLabel="Pipeline"
        eyebrow={`${deal.workspace.name} · ${deal.pipeline.name}`}
        title={deal.name}
        meta={
          <>
            <MetaItem label="Value">{formatMoney(deal.valueCents)}</MetaItem>
            {deal.company ? (
              <MetaItem label="Company">
                <Link href={`/companies/${deal.company.id}`} className="hover:underline">
                  {deal.company.name}
                </Link>
              </MetaItem>
            ) : null}
            <MetaItem label="Close">{formatDay(deal.expectedCloseAt, "not set")}</MetaItem>
            <MetaItem label="In stage">{daysInStage} days</MetaItem>
            {deal.owner ? <MetaItem label="Owner">{deal.owner.name}</MetaItem> : null}
          </>
        }
        actions={
          <>
            <AskAiButton focus={{ type: "deal", id: deal.id, label: deal.name }} />
            <RecordHeaderActions
              kind="deal"
              id={deal.id}
              name={deal.name}
              version={deal.version}
              context={editContext}
              initial={{
                name: deal.name,
                valueCents: deal.valueCents != null ? String(deal.valueCents / 100) : "",
                expectedCloseAt: deal.expectedCloseAt ? deal.expectedCloseAt.toISOString().slice(0, 10) : "",
                stageId: deal.stageId,
                companyId: deal.companyId,
                primaryContactId: deal.primaryContactId,
                projectId: deal.projectId,
              }}
            />
          </>
        }
      />

      <div className="mb-5">
        <StageSelector
          dealId={deal.id}
          currentStageId={deal.stage.id}
          stages={deal.pipeline.stages}
        />
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {/* Deal intelligence — the computed view, always current. */}
          <Panel>
            <PanelHeader
              title="Deal intelligence"
              description="Computed from stage, activity and engagement"
              icon={<TrendingUp />}
            />
            <div className="grid gap-px border-t border-hairline bg-hairline sm:grid-cols-3">
              <div className="bg-panel p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Win probability</p>
                <p className="mt-1.5 text-2xl font-semibold tabular text-body">{deal.intel.winProbability}%</p>
                <Progress value={deal.intel.winProbability} className="mt-2" />
                <p className="mt-2 text-[11.5px] text-muted">
                  Stage base rate {deal.stage.probability}%, adjusted for momentum.
                </p>
              </div>
              <div className="bg-panel p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Momentum</p>
                <div className="mt-1.5">
                  <ScoreExplainer
                    label={momentumLabel(deal.intel.momentum.value)}
                    tone={momentumTone(deal.intel.momentum.value)}
                    score={deal.intel.momentum.score}
                    summary={deal.intel.momentum.summary}
                    factors={deal.intel.momentum.factors}
                    caption="What moved this"
                  />
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{deal.intel.momentum.summary}</p>
              </div>
              <div className="bg-panel p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Last activity</p>
                <p className="mt-1.5 text-[15px] font-medium text-body">{timeAgo(deal.lastActivityAt)}</p>
                <p className="mt-2 text-[11.5px] text-muted">
                  {deal.tasks.filter((t) => t.status !== "done").length} open task(s) ·{" "}
                  {deal.contacts.length} contact(s)
                </p>
              </div>
            </div>

            <div className="border-t border-hairline p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                Recommended next action
              </p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-body">{deal.intel.recommendedAction}</p>

              {deal.intel.risks.length > 0 ? (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-900 dark:text-amber-300">
                    <AlertTriangle className="size-3.5" />
                    Risk factors
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {deal.intel.risks.map((risk) => (
                      <li key={risk} className="text-[12.5px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">
                        • {risk}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Panel>

          {summary ? (
            <AiSummaryCard
              entityType="deal"
              entityId={deal.id}
              body={summary.body}
              generatedAt={summary.generatedAt.toISOString()}
              providerLabel={describeProvider().label}
            />
          ) : null}

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="border-t border-hairline p-4">
              <TimelineComposer
                className="mb-5"
                links={{
                  workspaceId: deal.workspaceId,
                  dealId: deal.id,
                  companyId: deal.company?.id ?? null,
                  contactId: deal.primaryContact?.id ?? null,
                  projectId: deal.project?.id ?? null,
                }}
              />
              {deal.activities.length === 0 ? (
                <EmptyState
                  compact
                  title="Nothing logged yet"
                  description="Deals with no activity are the ones that quietly die. Log the last conversation."
                />
              ) : (
                <ActivityFeed items={deal.activities} />
              )}
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel>
            <PanelHeader title="Details" />
            <dl className="divide-y divide-hairline border-t border-hairline text-[13px]">
              <Row label="Stage">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: deal.stage.color }} />
                  {deal.stage.name}
                </span>
              </Row>
              <Row label="Value">{formatMoney(deal.valueCents)}</Row>
              <Row label="Expected close">{formatDate(deal.expectedCloseAt, "Not set")}</Row>
              <Row label="Source">{LEAD_SOURCE.label(deal.source, "—")}</Row>
              <Row label="Project">
                {deal.project ? (
                  <Link href={`/projects/${deal.project.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                    {deal.project.name}
                  </Link>
                ) : null}
              </Row>
              <Row label="Created">{formatDate(deal.createdAt)}</Row>
            </dl>

            {deal.nextStep ? (
              <div className="border-t border-hairline p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Next step</p>
                <p className="mt-1 text-[13px] leading-relaxed text-body">{deal.nextStep}</p>
              </div>
            ) : null}

            {deal.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline p-4">
                {deal.tags.map((tag) => (
                  <Badge key={tag.name} dot={tag.color}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Panel>

          <RelatedList
            title="People involved"
            icon={<Users />}
            description={
              deal.contacts.length <= 1 && deal.valueCents >= 2_500_000
                ? "Single-threaded on a large deal"
                : undefined
            }
            emptyTitle="No contacts"
            emptyDescription="Add the people who will make this decision."
            items={deal.contacts.map((link) => ({
              id: link.contact.id,
              href: `/contacts/${link.contact.id}`,
              title: link.contact.fullName,
              subtitle: link.contact.jobTitle ?? link.contact.email,
              leading: <Avatar name={link.contact.fullName} size="sm" />,
              trailing: link.role ? <Badge>{link.role}</Badge> : null,
            }))}
          />

          <Panel>
            <PanelHeader title="Tasks" icon={<CheckSquare />} />
            {deal.tasks.length === 0 ? (
              <div className="border-t border-hairline">
                <EmptyState compact title="No tasks" description="Nobody is driving this deal forward." />
              </div>
            ) : (
              <ul className="divide-y divide-hairline border-t border-hairline">
                {deal.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} showLinks={false} />
                ))}
              </ul>
            )}
          </Panel>

          {deal.notes.length > 0 ? (
            <RelatedList
              title="Notes"
              icon={<FileText />}
              emptyTitle="No notes"
              items={deal.notes.map((note) => ({
                id: note.id,
                href: `/notes/${note.id}`,
                title: note.title ?? "Untitled note",
                subtitle: note.plainText.slice(0, 100),
                trailing: <span className="text-[11px] text-faint">{formatDay(note.createdAt)}</span>,
              }))}
            />
          ) : null}

          {deal.files.length > 0 ? (
            <RelatedList
              title="Files"
              icon={<Paperclip />}
              emptyTitle="No files"
              items={deal.files.map((file) => ({
                id: file.id,
                title: file.name,
                subtitle: `${Math.round(file.sizeBytes / 1024)} KB · ${formatDay(file.createdAt)}`,
              }))}
            />
          ) : null}

          {deal.events.length > 0 ? (
            <RelatedList
              title="Meetings"
              icon={<CalendarDays />}
              emptyTitle="No meetings"
              items={deal.events.map((event) => ({
                id: event.id,
                title: event.title,
                subtitle: formatDay(event.startAt),
              }))}
            />
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}

function Row({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <dt className="w-28 shrink-0 text-[12px] text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-body">{children || <span className="text-faint">—</span>}</dd>
    </div>
  );
}

function momentumLabel(value: string) {
  return { high: "High momentum", steady: "Steady", slowing: "Slowing", stalled: "Stalled" }[value] ?? value;
}

function momentumTone(value: string) {
  return (
    { high: TONE.green, steady: TONE.blue, slowing: TONE.amber, stalled: TONE.rose }[value] ?? TONE.neutral
  );
}
