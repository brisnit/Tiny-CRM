import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CalendarClock, CheckSquare, ExternalLink, FileText, HelpCircle, ListChecks, Paperclip,
  ThumbsDown, ThumbsUp, Users,
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
import { AskAiButton } from "@/components/app/ask-ai-button";
import { RelatedList } from "@/components/app/related-list";
import { TaskRow } from "@/components/app/task-row";
import { RecordHeaderActions } from "@/components/app/record-edit";
import { StageSelector } from "@/components/app/stage-selector";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { getOpportunity } from "@/lib/data/opportunities";
import { getEditContext } from "@/lib/data/shell";
import { getRecordSummary } from "@/lib/ai/summaries";
import { describeProvider } from "@/lib/ai/provider";
import { formatMoney } from "@/lib/money";
import { dateOnlyInputValue, describeDateOnlyDeadline, formatDate, formatDateOnly, formatDay } from "@/lib/dates";
import {
  COMPETITION_LEVEL, OPPORTUNITY_TYPE, STRATEGIC_VALUE, SUBMISSION_STATUS, TONE,
} from "@/lib/enums";

export async function generateMetadata({ params }: PageProps<"/opportunities/[id]">) {
  const { id } = await params;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const opportunity = await getOpportunity(workspaceIds, id);
  return { title: opportunity?.name ?? "Opportunity" };
}

export default async function OpportunityPage({ params }: PageProps<"/opportunities/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const opportunity = await getOpportunity(workspaceIds, id);
  if (!opportunity) notFound();

  const workspaces = actor.memberships;
  const summary = await getRecordSummary(
    actor,
    { workspaceIds, workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])) },
    "opportunity",
    id,
    { workspaceId: opportunity.workspaceId },
  );

  const editContext = await getEditContext(actor, [opportunity.workspaceId]);

  const deadline = describeDateOnlyDeadline(opportunity.deadlineAt);
  const questions = describeDateOnlyDeadline(opportunity.questionsDeadlineAt);
  const rec = opportunity.assessment.recommendation;
  const openTasks = opportunity.tasks.filter((t) => t.status !== "done");

  return (
    <PageShell wide>
      <PageHeader
        backHref="/opportunities"
        backLabel="Opportunities"
        eyebrow={opportunity.workspace.name}
        title={opportunity.name}
        meta={
          <>
            <Badge tone={OPPORTUNITY_TYPE.tone(opportunity.type)}>
              {OPPORTUNITY_TYPE.label(opportunity.type)}
            </Badge>
            <Badge tone={SUBMISSION_STATUS.tone(opportunity.submissionStatus)}>
              {SUBMISSION_STATUS.label(opportunity.submissionStatus)}
            </Badge>
            {opportunity.company ? (
              <MetaItem label="Organization">
                <Link href={`/companies/${opportunity.company.id}`} className="hover:underline">
                  {opportunity.company.name}
                </Link>
              </MetaItem>
            ) : null}
            {opportunity.solicitationNumber ? (
              <MetaItem label="Solicitation">{opportunity.solicitationNumber}</MetaItem>
            ) : null}
            <MetaItem label="Value">{formatMoney(opportunity.estimatedValueCents)}</MetaItem>
          </>
        }
        actions={
          <>
            <AskAiButton focus={{ type: "opportunity", id: opportunity.id, label: opportunity.name }} />
            <RecordHeaderActions
              kind="opportunity"
              id={opportunity.id}
              name={opportunity.name}
              version={opportunity.version}
              context={editContext}
              initial={{
                name: opportunity.name,
                companyId: opportunity.companyId,
                solicitationNumber: opportunity.solicitationNumber,
                estimatedValueCents: opportunity.estimatedValueCents != null ? String(opportunity.estimatedValueCents / 100) : "",
                proposalDeadlineAt: dateOnlyInputValue(opportunity.proposalDeadlineAt),
                projectId: opportunity.projectId,
              }}
            />
          </>
        }
      />

      {opportunity.pipeline && opportunity.stage ? (
        <div className="mb-5">
          <StageSelector
            opportunityId={opportunity.id}
            currentStageId={opportunity.stage.id}
            stages={opportunity.pipeline.stages}
          />
        </div>
      ) : null}

      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {/* Go / no-go */}
          <Panel>
            <PanelHeader
              title="Go / no-go"
              description={
                opportunity.assessment.assessed
                  ? "Computed from fit, strategic value, competition, value and time remaining"
                  : "Needs a fit score, strategic value or competition level before Tiny can weigh in"
              }
              icon={
                !opportunity.assessment.assessed ? <HelpCircle />
                  : rec === "go" || rec === "lean_go" ? <ThumbsUp /> : <ThumbsDown />
              }
            />
            <div className="border-t border-hairline p-4">
              {/*
                An unjudged opportunity gets no verdict.

                The scorer needs a human input to say anything; with none it is
                working from the deadline and the contact count, which for an
                imported backlog is every row — so it floors all of them. An
                82/GO closing in four days came out "no bid" against a real
                tracker. Showing that argues against work somebody has already
                decided to pursue, so it says nothing instead, and says so.
              */}
              {!opportunity.assessment.assessed ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="stone" className="px-2.5 py-1 text-[12px]">Not yet assessed</Badge>
                  <span className="text-[13px] text-muted">
                    Set a fit score, strategic value or competition level and Tiny will weigh in.
                  </span>
                </div>
              ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={recTone(rec)} className="px-2.5 py-1 text-[12px]">
                  {recLabel(rec)}
                </Badge>
                <span className="text-[13px] text-muted">{opportunity.assessment.summary}</span>
              </div>
              )}
              {opportunity.assessment.assessed ? (<>
              <div className="mt-3">
                <div className="mb-1 flex items-baseline justify-between text-[11px]">
                  <span className="text-faint">Confidence</span>
                  <span className="text-muted tabular">{opportunity.assessment.score}/100</span>
                </div>
                <Progress
                  value={opportunity.assessment.score}
                  barClassName={
                    opportunity.assessment.score >= 55 ? "bg-brand-500" : "bg-amber-500"
                  }
                />
              </div>

              <ul className="mt-4 space-y-2.5 border-t border-hairline pt-4">
                {opportunity.assessment.reasons.map((reason, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                        reason.impact > 0 ? "bg-emerald-500" : reason.impact < 0 ? "bg-rose-500" : "bg-faint"
                      }`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-body">{reason.label}</span>
                      <span className="block text-[12.5px] leading-relaxed text-muted">{reason.detail}</span>
                    </span>
                    <span
                      className={`shrink-0 text-[11px] font-medium tabular ${
                        reason.impact > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                      }`}
                    >
                      {reason.impact > 0 ? "+" : ""}
                      {reason.impact}
                    </span>
                  </li>
                ))}
              </ul>
              </>) : null}

              {opportunity.importedFrom ? <SourceComparison source={opportunity.importedFrom} /> : null}
            </div>
          </Panel>

          {summary ? (
            <AiSummaryCard
              entityType="opportunity"
              entityId={opportunity.id}
              body={summary.body}
              generatedAt={summary.generatedAt.toISOString()}
              providerLabel={describeProvider().label}
            />
          ) : null}

          {opportunity.requirementList.length > 0 ? (
            <Panel>
              <PanelHeader
                title="Requirements"
                description={`${opportunity.requirementList.length} stated requirements`}
                icon={<ListChecks />}
              />
              <ul className="divide-y divide-hairline border-t border-hairline">
                {opportunity.requirementList.map((requirement, i) => (
                  <li key={i} className="flex gap-2.5 px-4 py-2.5">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                    <span className="text-[13px] leading-relaxed text-body">{requirement}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="border-t border-hairline p-4">
              <TimelineComposer
                className="mb-5"
                links={{
                  workspaceId: opportunity.workspaceId,
                  opportunityId: opportunity.id,
                  companyId: opportunity.company?.id ?? null,
                }}
              />
              {opportunity.activities.length === 0 ? (
                <EmptyState compact title="Nothing logged yet" />
              ) : (
                <ActivityFeed items={opportunity.activities} />
              )}
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel>
            <PanelHeader title="Key dates" icon={<CalendarClock />} />
            <dl className="divide-y divide-hairline border-t border-hairline text-[13px]">
              <Row label="Posted">{formatDateOnly(opportunity.postedAt, "Not recorded")}</Row>
              <Row label="Questions due">
                {opportunity.questionsDeadlineAt ? (
                  <span className={questions.urgent ? "font-medium text-amber-600 dark:text-amber-400" : undefined}>
                    {formatDateOnly(opportunity.questionsDeadlineAt)} · {questions.label}
                  </span>
                ) : null}
              </Row>
              <Row label="Proposal due">
                {opportunity.proposalDeadlineAt ?? opportunity.deadlineAt ? (
                  <span
                    className={
                      deadline.overdue
                        ? "font-medium text-rose-600 dark:text-rose-400"
                        : deadline.urgent
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : undefined
                    }
                  >
                    {formatDateOnly(opportunity.proposalDeadlineAt ?? opportunity.deadlineAt)} · {deadline.label}
                  </span>
                ) : null}
              </Row>
            </dl>
          </Panel>

          <Panel>
            <PanelHeader title="Assessment" />
            <dl className="divide-y divide-hairline border-t border-hairline text-[13px]">
              <Row label="Fit score">
                {opportunity.fitScore !== null ? `${opportunity.fitScore}/100` : null}
              </Row>
              <Row label="Strategic value">{STRATEGIC_VALUE.label(opportunity.strategicValue, "")}</Row>
              <Row label="Competition">{COMPETITION_LEVEL.label(opportunity.competitionLevel, "")}</Row>
              <Row label="Source">{opportunity.source}</Row>
              <Row label="Owner">{opportunity.owner?.name}</Row>
              <Row label="Project">
                {opportunity.project ? (
                  <Link
                    href={`/projects/${opportunity.project.id}`}
                    className="text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {opportunity.project.name}
                  </Link>
                ) : null}
              </Row>
              <Row label="Proposal">
                {opportunity.proposalUrl ? (
                  <a
                    href={opportunity.proposalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                  >
                    Open
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </Row>
            </dl>

            {opportunity.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline p-4">
                {opportunity.tags.map((tag) => (
                  <Badge key={tag.name} dot={tag.color}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Tasks" icon={<CheckSquare />} description={`${openTasks.length} open`} />
            {openTasks.length === 0 ? (
              <div className="border-t border-hairline">
                <EmptyState
                  compact
                  title="No open tasks"
                  description={
                    deadline.urgent
                      ? "A deadline this close with no tasks is how bids get missed."
                      : undefined
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-hairline border-t border-hairline">
                {openTasks.map((task) => (
                  <TaskRow key={task.id} task={task} showLinks={false} />
                ))}
              </ul>
            )}
          </Panel>

          <RelatedList
            title="Contacts"
            icon={<Users />}
            emptyTitle="No contacts"
            emptyDescription="Cold solicitations win far less often than warm ones."
            items={opportunity.contacts.map((link) => ({
              id: link.contact.id,
              href: `/contacts/${link.contact.id}`,
              title: link.contact.fullName,
              subtitle: link.contact.jobTitle ?? link.contact.email,
              leading: <Avatar name={link.contact.fullName} size="sm" />,
            }))}
          />

          {opportunity.files.length > 0 ? (
            <RelatedList
              title="Files"
              icon={<Paperclip />}
              emptyTitle="No files"
              items={opportunity.files.map((file) => ({
                id: file.id,
                title: file.name,
                subtitle: `${Math.round(file.sizeBytes / 1024)} KB · ${formatDay(file.createdAt)}`,
              }))}
            />
          ) : null}

          {opportunity.notes.length > 0 ? (
            <RelatedList
              title="Notes"
              icon={<FileText />}
              emptyTitle="No notes"
              items={opportunity.notes.map((note) => ({
                id: note.id,
                href: `/notes/${note.id}`,
                title: note.title ?? "Untitled note",
                subtitle: note.plainText.slice(0, 100),
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
      <dd className="min-w-0 flex-1 text-body">{children || <span className="text-faint">—</span>}</dd>
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

/**
 * What the spreadsheet said, beside what Tiny says.
 *
 * The source figures were true when the file was exported and are frozen;
 * Tiny's move as the deadline closes in. Showing only Tiny's throws away the
 * working history somebody built up over months, and showing only the source's
 * presents a stale number as current. So both, labelled, with the date the
 * import happened so it is obvious which one is old.
 *
 * Only columns the person recognises are surfaced — the scoring model, the
 * verdict and the notes. The whole row is still on the import record.
 */
function SourceComparison({
  source,
}: {
  source: { fileName: string; importedAt: Date; rowIndex: number; values: Record<string, string> };
}) {
  // The judgement the spreadsheet carried, in the spreadsheet's own words: the
  // headline score and verdict, any adjusted score, and the dimensions they
  // were built from. Everything else on the row is provenance too, but this is
  // the part that answers "what did I already think of this one?".
  const interesting = Object.entries(source.values).filter(
    ([key, value]) =>
      value.trim() !== "" &&
      /score|verdict|rating|days? left|runway|recommend|decision|bump|scope|platform|access|action\b|pref|weighted|option/i.test(key),
  );
  if (interesting.length === 0) return null;

  return (
    <div className="mt-4 border-t border-hairline pt-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
        As imported
      </p>
      <p className="mt-0.5 text-[12px] text-muted">
        From {source.fileName}, row {source.rowIndex + 1}, on {formatDate(source.importedAt)}. These are the
        spreadsheet&rsquo;s own figures, kept exactly as they were on the day of the import. They are not
        Tiny&rsquo;s assessment and are not recalculated.
      </p>
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        {interesting.map(([key, value]) => (
          <div key={key} className="text-[12px]">
            <dt className="text-faint">{key}</dt>
            <dd className="font-medium tabular text-body">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
