import Link from "next/link";
import { CalendarDays, Mail, Plug, Video } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireUser, resolveScope } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { formatDay, formatTime, timeAgo } from "@/lib/dates";

export const metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const user = await requireUser();
  const { workspaceIds } = await resolveScope(user.id, await readScope());
  const now = new Date();

  const [upcoming, past, unanswered, integrations] = await Promise.all([
    db.calendarEvent.findMany({
      where: { workspaceId: { in: workspaceIds }, startAt: { gte: now } },
      select: {
        id: true, title: true, startAt: true, endAt: true, meetingUrl: true, location: true,
        contact: { select: { id: true, fullName: true } },
        company: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        attendees: { select: { id: true, name: true, email: true } },
      },
      orderBy: { startAt: "asc" },
      take: 40,
    }),
    db.calendarEvent.findMany({
      where: { workspaceId: { in: workspaceIds }, startAt: { lt: now } },
      select: {
        id: true, title: true, startAt: true,
        contact: { select: { id: true, fullName: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { startAt: "desc" },
      take: 10,
    }),
    db.emailMessage.findMany({
      where: { workspaceId: { in: workspaceIds }, needsReply: true },
      select: {
        id: true, subject: true, snippet: true, sentAt: true, direction: true,
        contact: { select: { id: true, fullName: true } },
      },
      orderBy: { sentAt: "asc" },
      take: 10,
    }),
    db.integration.findMany({
      where: { workspaceId: { in: workspaceIds }, userId: user.id },
      select: { provider: true, status: true, accountEmail: true, lastSyncAt: true },
      distinct: ["provider"],
    }),
  ]);

  // Group the schedule by day so it reads as a calendar, not a list.
  const days = new Map<string, typeof upcoming>();
  for (const event of upcoming) {
    const key = formatDay(event.startAt);
    days.set(key, [...(days.get(key) ?? []), event]);
  }

  return (
    <PageShell>
      <PageHeader
        title="Calendar"
        description="Meetings, attached to the work they belong to."
        actions={<NewRecordButton kind="meeting" label="Log a meeting" variant="outline" />}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {upcoming.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<CalendarDays />}
                title="Nothing scheduled"
                description="Connect Google Calendar or Outlook and your meetings will appear here, linked to the right contacts and projects."
                action={{ label: "Connect a calendar", href: "/settings/integrations" }}
              />
            </Panel>
          ) : (
            Array.from(days.entries()).map(([day, events]) => (
              <Panel key={day}>
                <PanelHeader title={day} description={`${events.length} meeting${events.length === 1 ? "" : "s"}`} />
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {events.map((event) => (
                    <li key={event.id} className="flex items-start gap-3 px-4 py-3">
                      <div className="w-16 shrink-0">
                        <div className="text-[13px] font-medium tabular text-body">{formatTime(event.startAt)}</div>
                        <div className="text-[11px] text-faint tabular">{formatTime(event.endAt)}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium text-body">{event.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {event.contact ? (
                            <Link
                              href={`/contacts/${event.contact.id}`}
                              className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hairline hover:text-body"
                            >
                              {event.contact.fullName}
                            </Link>
                          ) : null}
                          {event.project ? (
                            <Link
                              href={`/projects/${event.project.id}`}
                              className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hairline hover:text-body"
                            >
                              {event.project.name}
                            </Link>
                          ) : null}
                          {event.attendees.length > 1 ? (
                            <span className="text-[11px] text-faint">
                              {event.attendees.length} attendees
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {event.meetingUrl ? (
                        <Button asChild size="xs" variant="outline">
                          <a href={event.meetingUrl} target="_blank" rel="noreferrer">
                            <Video className="size-3" />
                            Join
                          </a>
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ))
          )}

          {past.length > 0 ? (
            <Panel>
              <PanelHeader title="Recent meetings" />
              <ul className="divide-y divide-hairline border-t border-hairline">
                {past.map((event) => (
                  <li key={event.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-20 shrink-0 text-[11.5px] text-faint">{formatDay(event.startAt)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-body">{event.title}</span>
                    <span className="shrink-0 text-[11.5px] text-faint">
                      {event.contact?.fullName ?? event.project?.name ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-5">
          <Panel>
            <PanelHeader
              title="Waiting on a reply"
              description="Threads that have gone unanswered"
              icon={<Mail />}
            />
            {unanswered.length === 0 ? (
              <div className="border-t border-hairline">
                <EmptyState compact title="Inbox is clear" description="Nothing is waiting on a reply." />
              </div>
            ) : (
              <ul className="divide-y divide-hairline border-t border-hairline">
                {unanswered.map((email) => (
                  <li key={email.id} className="px-4 py-3">
                    <p className="truncate text-[13px] font-medium text-body">{email.subject}</p>
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{email.snippet}</p>
                    <p className="mt-1.5 text-[11px] text-faint">
                      {email.direction === "outbound" ? "Sent to" : "From"}{" "}
                      {email.contact?.fullName ?? "unknown"} · {timeAgo(email.sentAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Connections" icon={<Plug />} />
            <ul className="divide-y divide-hairline border-t border-hairline">
              {integrations.map((integration) => (
                <li key={integration.provider} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium capitalize text-body">
                      {integration.provider.replace(/_/g, " ")}
                    </span>
                    <span className="block truncate text-[11px] text-faint">
                      {integration.accountEmail} · synced {timeAgo(integration.lastSyncAt)}
                    </span>
                  </span>
                  <Badge
                    tone={
                      integration.status === "connected"
                        ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900"
                        : undefined
                    }
                  >
                    {integration.status === "mock" ? "Demo data" : integration.status}
                  </Badge>
                </li>
              ))}
            </ul>
            <div className="border-t border-hairline p-4">
              <p className="text-[12px] leading-relaxed text-muted">
                Calendar and email are running on seeded demo data. The sync layer upserts on{" "}
                <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[11px]">(provider, externalId)</code>,
                so connecting a real account replaces this data without a schema change.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link href="/settings/integrations">Manage connections</Link>
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}
