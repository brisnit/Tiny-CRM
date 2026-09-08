import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Building2, CalendarDays, CheckSquare, ExternalLink, FileText, FolderKanban, Link2, Mail, MapPin, Paperclip, Phone, Target,
} from "lucide-react";

import { PageHeader, PageShell, MetaItem } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
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
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { getContact } from "@/lib/data/contacts";
import { getEditContext } from "@/lib/data/shell";
import { getRecordSummary } from "@/lib/ai/summaries";
import { describeProvider } from "@/lib/ai/provider";
import { formatCompact } from "@/lib/money";
import { formatDate, formatDay, timeAgo, daysSince } from "@/lib/dates";
import { LEAD_SOURCE, RELATIONSHIP_STRENGTH, RELATIONSHIP_TYPE } from "@/lib/enums";

export async function generateMetadata({ params }: PageProps<"/contacts/[id]">) {
  const { id } = await params;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const contact = await getContact(workspaceIds, id);
  return { title: contact?.fullName ?? "Contact" };
}

export default async function ContactPage({ params }: PageProps<"/contacts/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const contact = await getContact(workspaceIds, id);
  if (!contact) notFound();

  const workspaces = actor.memberships;
  const summary = await getRecordSummary(
    actor,
    { workspaceIds, workspaceNames: new Map(workspaces.map((w) => [w.id, w.name])) },
    "contact",
    id,
    { workspaceId: contact.workspaceId },
  );

  const editContext = await getEditContext(actor, [contact.workspaceId]);

  const openDeals = contact.deals.filter((d) => d.deal.stage.kind === "open");
  const since = daysSince(contact.lastContactedAt);
  const followUpOverdue = contact.nextFollowUpAt && contact.nextFollowUpAt < new Date();

  return (
    <PageShell wide>
      <PageHeader
        backHref="/contacts"
        backLabel="Contacts"
        eyebrow={contact.workspace.name}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={contact.fullName} size="xl" />
            <span>{contact.fullName}</span>
          </span>
        }
        description={
          [contact.jobTitle, contact.company?.name].filter(Boolean).join(" at ") || undefined
        }
        meta={
          <>
            <ScoreExplainer
              label={RELATIONSHIP_STRENGTH.label(contact.relationship.value)}
              tone={RELATIONSHIP_STRENGTH.tone(contact.relationship.value)}
              score={contact.relationship.score}
              summary={contact.relationship.summary}
              factors={contact.relationship.factors}
              caption="What drives this score"
            />
            <Badge tone={RELATIONSHIP_TYPE.tone(contact.relationshipType)}>
              {RELATIONSHIP_TYPE.label(contact.relationshipType)}
            </Badge>
            <MetaItem label="Last contact">
              {since === null ? "Never" : since === 0 ? "Today" : `${since} days ago`}
            </MetaItem>
            {contact.nextFollowUpAt ? (
              <MetaItem label="Follow-up">
                <span className={followUpOverdue ? "text-rose-600 dark:text-rose-400" : undefined}>
                  {formatDay(contact.nextFollowUpAt)}
                  {followUpOverdue ? " (overdue)" : ""}
                </span>
              </MetaItem>
            ) : null}
            {contact.owner ? <MetaItem label="Owner">{contact.owner.name}</MetaItem> : null}
          </>
        }
        actions={
          <>
            <AskAiButton focus={{ type: "contact", id: contact.id, label: contact.fullName }} />
            <RecordHeaderActions
              kind="contact"
              id={contact.id}
              name={contact.fullName}
              version={contact.version}
              context={editContext}
              initial={{
                firstName: contact.firstName,
                lastName: contact.lastName,
                email: contact.email,
                jobTitle: contact.jobTitle,
                companyId: contact.companyId,
                relationshipType: contact.relationshipType,
              }}
            />
          </>
        }
      />

      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {summary ? (
            <AiSummaryCard
              entityType="contact"
              entityId={contact.id}
              body={summary.body}
              generatedAt={summary.generatedAt.toISOString()}
              providerLabel={describeProvider().label}
            />
          ) : null}

          <Panel>
            <PanelHeader title="Timeline" description="Everything that has happened with this person" />
            <div className="border-t border-hairline p-4">
              <TimelineComposer
                className="mb-5"
                links={{
                  workspaceId: contact.workspaceId,
                  contactId: contact.id,
                  companyId: contact.company?.id ?? null,
                }}
              />
              {contact.activities.length === 0 ? (
                <EmptyState
                  compact
                  title="Nothing logged yet"
                  description="Log a call, meeting or note above. History is what makes the relationship score meaningful."
                />
              ) : (
                <ActivityFeed items={contact.activities} />
              )}
            </div>
          </Panel>

          {contact.notes.length > 0 ? (
            <RelatedList
              title="Notes"
              icon={<FileText />}
              emptyTitle="No notes"
              items={contact.notes.map((note) => ({
                id: note.id,
                href: `/notes/${note.id}`,
                title: note.title ?? "Untitled note",
                subtitle: note.plainText.slice(0, 110),
                trailing: <span className="text-[11px] text-faint">{formatDay(note.createdAt)}</span>,
              }))}
            />
          ) : null}

          {contact.emails.length > 0 ? (
            <RelatedList
              title="Recent email"
              description="Synced from the connected mailbox"
              icon={<Mail />}
              emptyTitle="No email yet"
              items={contact.emails.map((email) => ({
                id: email.id,
                title: email.subject,
                subtitle: email.snippet,
                trailing: (
                  <div className="flex items-center gap-2">
                    {email.needsReply ? <Badge tone="bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">Needs reply</Badge> : null}
                    <span className="text-[11px] text-faint">{formatDay(email.sentAt)}</span>
                  </div>
                ),
              }))}
            />
          ) : null}
        </div>

        <div className="min-w-0 space-y-5">
          <Panel>
            <PanelHeader title="Details" />
            <dl className="divide-y divide-hairline border-t border-hairline text-[13px]">
              <DetailRow label="Email" icon={<Mail />}>
                {contact.email ? (
                  <a href={`mailto:${contact.email}`} className="text-brand-600 hover:underline dark:text-brand-400">
                    {contact.email}
                  </a>
                ) : null}
              </DetailRow>
              <DetailRow label="Phone" icon={<Phone />}>
                {contact.phone ? (
                  <a href={`tel:${contact.phone}`} className="text-body hover:underline">
                    {contact.phone}
                  </a>
                ) : null}
              </DetailRow>
              <DetailRow label="Company" icon={<Building2 />}>
                {contact.company ? (
                  <Link href={`/companies/${contact.company.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                    {contact.company.name}
                  </Link>
                ) : null}
              </DetailRow>
              <DetailRow label="Location" icon={<MapPin />}>{contact.location}</DetailRow>
              <DetailRow label="LinkedIn" icon={<Link2 />}>
                {contact.linkedin ? (
                  <a
                    href={contact.linkedin}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                  >
                    Profile
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </DetailRow>
              <DetailRow label="Lead source">{LEAD_SOURCE.label(contact.leadSource, "")}</DetailRow>
              <DetailRow label="Added">{formatDate(contact.createdAt)}</DetailRow>
            </dl>

            {contact.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline p-4">
                {contact.tags.map((tag) => (
                  <Badge key={tag.name} dot={tag.color}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader
              title="Open tasks"
              icon={<CheckSquare />}
              description={contact.tasks.length === 0 ? undefined : `${contact.tasks.length} open`}
            />
            {contact.tasks.length === 0 ? (
              <div className="border-t border-hairline">
                <EmptyState compact title="Nothing to do" description="Add a task from the timeline above." />
              </div>
            ) : (
              <ul className="divide-y divide-hairline border-t border-hairline">
                {contact.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            )}
          </Panel>

          <RelatedList
            title="Deals"
            icon={<Target />}
            description={openDeals.length > 0 ? `${openDeals.length} open` : undefined}
            emptyTitle="No deals"
            emptyDescription="Deals this person is involved in will show up here."
            items={contact.deals.map((link) => ({
              id: link.deal.id,
              href: `/deals/${link.deal.id}`,
              title: link.deal.name,
              subtitle: link.deal.stage.name,
              leading: (
                <span className="size-2 shrink-0 rounded-full" style={{ background: link.deal.stage.color }} />
              ),
              trailing: (
                <span className="text-[12px] font-medium tabular text-body">
                  {formatCompact(link.deal.valueCents)}
                </span>
              ),
            }))}
          />

          <RelatedList
            title="Projects"
            icon={<FolderKanban />}
            emptyTitle="No projects"
            emptyDescription="Projects this person is attached to will show up here."
            items={contact.projects.map((link) => ({
              id: link.project.id,
              href: `/projects/${link.project.id}`,
              title: link.project.name,
              subtitle: link.project.status?.name,
              leading: (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: link.project.status?.color ?? "#94a3b8" }}
                />
              ),
            }))}
          />

          {contact.events.length > 0 ? (
            <RelatedList
              title="Meetings"
              icon={<CalendarDays />}
              emptyTitle="No meetings"
              items={contact.events.map((event) => ({
                id: event.id,
                title: event.title,
                subtitle: timeAgo(event.startAt),
              }))}
            />
          ) : null}

          {contact.files.length > 0 ? (
            <RelatedList
              title="Files"
              icon={<Paperclip />}
              emptyTitle="No files"
              items={contact.files.map((file) => ({
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

function DetailRow({
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
      <dt className="flex w-24 shrink-0 items-center gap-1.5 text-[12px] text-faint">
        {icon ? <span className="[&_svg]:size-3.5">{icon}</span> : null}
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate text-body">{children || <span className="text-faint">—</span>}</dd>
    </div>
  );
}
