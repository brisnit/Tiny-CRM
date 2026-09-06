import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Building2, CheckSquare, ExternalLink, FileText, FolderKanban, Globe,
  Landmark, MapPin, Paperclip, Target, Users,
} from "lucide-react";

import { PageHeader, PageShell, MetaItem } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { StatRow, StatTile } from "@/components/app/stat-tile";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { ActivityFeed } from "@/components/app/activity-feed";
import { TimelineComposer } from "@/components/app/timeline-composer";
import { AiSummaryCard } from "@/components/app/ai-summary-card";
import { AskAiButton } from "@/components/app/ask-ai-button";
import { RelatedList } from "@/components/app/related-list";
import { TaskRow } from "@/components/app/task-row";
import { RecordActions } from "@/components/app/record-actions";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { getCompany } from "@/lib/data/companies";
import { getRecordSummary } from "@/lib/ai/summaries";
import { describeProvider } from "@/lib/ai/provider";
import { formatCompact, formatMoney } from "@/lib/money";
import { formatDay, timeAgo, daysSince } from "@/lib/dates";
import {
  COMPANY_SIZE, COMPANY_TYPE, LEAD_SOURCE, RELATIONSHIP_STATUS, REVENUE_RANGE, SUBMISSION_STATUS,
} from "@/lib/enums";

export async function generateMetadata({ params }: PageProps<"/companies/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const company = await getCompany(workspaceIds, id);
  return { title: company?.name ?? "Company" };
}

export default async function CompanyPage({ params }: PageProps<"/companies/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const company = await getCompany(workspaceIds, id);
  if (!company) notFound();

  const workspaces = actor.memberships;
  const summary = await getRecordSummary(
    actor,
    { workspaceIds, workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])) },
    "company",
    id,
    { workspaceId: company.workspaceId },
  );

  return (
    <PageShell wide>
      <PageHeader
        backHref="/companies"
        backLabel="Companies"
        eyebrow={company.workspace.name}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={company.name} size="xl" square />
            <span>{company.name}</span>
          </span>
        }
        description={company.description ?? undefined}
        meta={
          <>
            {company.type ? (
              <Badge tone={COMPANY_TYPE.tone(company.type)}>{COMPANY_TYPE.label(company.type)}</Badge>
            ) : null}
            <Badge tone={RELATIONSHIP_STATUS.tone(company.relationshipStatus)}>
              {RELATIONSHIP_STATUS.label(company.relationshipStatus)}
            </Badge>
            {company.industry ? <MetaItem label="Industry">{company.industry}</MetaItem> : null}
            {company.location ? (
              <MetaItem label="Location" icon={<MapPin />}>
                {company.location}
              </MetaItem>
            ) : null}
            <MetaItem label="Last activity">{timeAgo(company.lastActivityAt)}</MetaItem>
          </>
        }
        actions={
          <>
            <AskAiButton focus={{ type: "company", id: company.id, label: company.name }} />
            <RecordActions
              entityType="company"
              id={company.id}
              name={company.name}
            />
          </>
        }
      />

      <div className="mb-5">
        <StatRow className="lg:grid-cols-4">
          <StatTile
            label="Open pipeline"
            value={formatCompact(company.stats.openPipelineCents)}
            hint={`${company.stats.openDealCount} open deal${company.stats.openDealCount === 1 ? "" : "s"}`}
            tone="brand"
          />
          <StatTile label="Won" value={formatCompact(company.stats.wonCents)} hint="Closed-won value" />
          <StatTile
            label="Project revenue"
            value={formatCompact(company.stats.revenueCents)}
            hint={`${company.projects.length} project${company.projects.length === 1 ? "" : "s"}`}
          />
          <StatTile label="People" value={company.contacts.length} hint="Contacts on this account" />
        </StatRow>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {summary ? (
            <AiSummaryCard
              entityType="company"
              entityId={company.id}
              body={summary.body}
              generatedAt={summary.generatedAt.toISOString()}
              providerLabel={describeProvider().label}
            />
          ) : null}

          <RelatedList
            title="Deals"
            icon={<Target />}
            emptyTitle="No deals yet"
            emptyDescription="Track revenue in play with this account."
            items={company.deals.map((deal) => ({
              id: deal.id,
              href: `/deals/${deal.id}`,
              title: deal.name,
              subtitle: `${deal.stage.name} · closes ${formatDay(deal.expectedCloseAt, "unset")}`,
              leading: <span className="size-2 shrink-0 rounded-full" style={{ background: deal.stage.color }} />,
              trailing: (
                <span className="text-[12.5px] font-medium tabular text-body">
                  {formatCompact(deal.valueCents)}
                </span>
              ),
            }))}
          />

          <RelatedList
            title="Projects"
            icon={<FolderKanban />}
            emptyTitle="No projects yet"
            emptyDescription="Work you are delivering for this account will live here."
            items={company.projects.map((project) => ({
              id: project.id,
              href: `/projects/${project.id}`,
              title: project.name,
              subtitle: `${project.status?.name ?? "No status"} · due ${formatDay(project.targetDate, "unset")}`,
              leading: (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: project.status?.color ?? "#94a3b8" }}
                />
              ),
              trailing: project.revenueCents ? (
                <span className="text-[12.5px] tabular text-muted">{formatCompact(project.revenueCents)}</span>
              ) : null,
            }))}
          />

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="border-t border-hairline p-4">
              <TimelineComposer
                className="mb-5"
                links={{ workspaceId: company.workspaceId, companyId: company.id }}
              />
              {company.activities.length === 0 ? (
                <EmptyState compact title="Nothing logged yet" description="Log the last conversation with this account." />
              ) : (
                <ActivityFeed items={company.activities} />
              )}
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel>
            <PanelHeader title="Details" />
            <dl className="divide-y divide-hairline border-t border-hairline text-[13px]">
              <Row label="Website" icon={<Globe />}>
                {company.website ? (
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {company.domain ?? company.website.replace(/^https?:\/\//, "")}
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </Row>
              <Row label="Size" icon={<Users />}>{COMPANY_SIZE.label(company.size, "")}</Row>
              <Row label="Revenue" icon={<Building2 />}>{REVENUE_RANGE.label(company.revenueRange, "")}</Row>
              <Row label="Lead source">{LEAD_SOURCE.label(company.leadSource, "")}</Row>
              <Row label="Owner">{company.owner?.name}</Row>
              <Row label="Primary contact">
                {company.primaryContact ? (
                  <Link
                    href={`/contacts/${company.primaryContact.id}`}
                    className="text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {company.primaryContact.fullName}
                  </Link>
                ) : null}
              </Row>
            </dl>

            {company.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline p-4">
                {company.tags.map((tag) => (
                  <Badge key={tag.name} dot={tag.color}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Panel>

          <RelatedList
            title="People"
            icon={<Users />}
            emptyTitle="No contacts"
            emptyDescription="Add the people you work with here."
            items={company.contacts.map((contact) => {
              const since = daysSince(contact.lastContactedAt);
              return {
                id: contact.id,
                href: `/contacts/${contact.id}`,
                title: contact.fullName,
                subtitle: contact.jobTitle ?? contact.email,
                leading: <Avatar name={contact.fullName} size="sm" />,
                trailing: (
                  <span className="text-[11px] text-faint tabular">
                    {since === null ? "—" : `${since}d`}
                  </span>
                ),
              };
            })}
          />

          <Panel>
            <PanelHeader title="Open tasks" icon={<CheckSquare />} />
            {company.tasks.length === 0 ? (
              <div className="border-t border-hairline">
                <EmptyState compact title="Nothing to do" />
              </div>
            ) : (
              <ul className="divide-y divide-hairline border-t border-hairline">
                {company.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            )}
          </Panel>

          {company.opportunities.length > 0 ? (
            <RelatedList
              title="Opportunities"
              icon={<Landmark />}
              emptyTitle="No opportunities"
              items={company.opportunities.map((opp) => ({
                id: opp.id,
                href: `/opportunities/${opp.id}`,
                title: opp.name,
                subtitle: `Due ${formatDay(opp.deadlineAt, "unset")} · ${formatMoney(opp.estimatedValueCents)}`,
                trailing: (
                  <Badge tone={SUBMISSION_STATUS.tone(opp.submissionStatus)}>
                    {SUBMISSION_STATUS.label(opp.submissionStatus)}
                  </Badge>
                ),
              }))}
            />
          ) : null}

          {company.notes.length > 0 ? (
            <RelatedList
              title="Notes"
              icon={<FileText />}
              emptyTitle="No notes"
              items={company.notes.map((note) => ({
                id: note.id,
                href: `/notes/${note.id}`,
                title: note.title ?? "Untitled note",
                subtitle: note.plainText.slice(0, 100),
              }))}
            />
          ) : null}

          {company.files.length > 0 ? (
            <RelatedList
              title="Files"
              icon={<Paperclip />}
              emptyTitle="No files"
              items={company.files.map((file) => ({
                id: file.id,
                title: file.name,
                subtitle: `${Math.round(file.sizeBytes / 1024)} KB`,
              }))}
            />
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}

function Row({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <dt className="flex w-28 shrink-0 items-center gap-1.5 text-[12px] text-faint">
        {icon ? <span className="[&_svg]:size-3.5">{icon}</span> : null}
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate text-body">{children || <span className="text-faint">—</span>}</dd>
    </div>
  );
}
