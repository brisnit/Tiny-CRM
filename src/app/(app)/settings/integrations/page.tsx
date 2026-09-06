import { Calendar, Mail, Plug } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/dates";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Integrations" };

const PROVIDERS = [
  { id: "gmail", name: "Gmail", icon: Mail, blurb: "Log email with contacts, associate threads with projects and deals, and flag what has gone unanswered." },
  { id: "outlook", name: "Outlook", icon: Mail, blurb: "The same, for Microsoft 365 mailboxes." },
  { id: "google_calendar", name: "Google Calendar", icon: Calendar, blurb: "Pull meetings in and attach them to the right contact, company and project." },
  { id: "outlook_calendar", name: "Outlook Calendar", icon: Calendar, blurb: "The same, for Microsoft 365 calendars." },
];

export default async function IntegrationSettings() {
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());

  const connected = await scopedRead(workspaceIds, () =>
    db.integration.findMany({
      where: { workspaceId: { in: workspaceIds }, userId: actor.identity.id },
      select: { provider: true, status: true, accountEmail: true, lastSyncAt: true },
      distinct: ["provider"],
    }),
  );
  const byProvider = new Map(connected.map((c) => [c.provider, c]));

  const [emailCount, eventCount] = await scopedRead(workspaceIds, () =>
    Promise.all([
      db.emailMessage.count({ where: { workspaceId: { in: workspaceIds } } }),
      db.calendarEvent.count({ where: { workspaceId: { in: workspaceIds } } }),
    ]),
  );

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Email & calendar"
          description="Currently running on seeded demo data"
          icon={<Plug />}
        />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {PROVIDERS.map((provider) => {
            const state = byProvider.get(provider.id);
            return (
              <li key={provider.id} className="flex flex-wrap items-start gap-3 px-4 py-3.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-faint">
                  <provider.icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13.5px] font-semibold text-body">{provider.name}</p>
                    {state ? (
                      <Badge
                        tone={
                          state.status === "connected"
                            ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900"
                            : undefined
                        }
                      >
                        {state.status === "mock" ? "Demo data" : state.status}
                      </Badge>
                    ) : (
                      <Badge>Not connected</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{provider.blurb}</p>
                  {state?.accountEmail ? (
                    <p className="mt-1 text-[11.5px] text-faint">
                      {state.accountEmail} · last synced {timeAgo(state.lastSyncAt)}
                    </p>
                  ) : null}
                </div>
                <Button size="sm" variant="outline" disabled>
                  {state ? "Reconnect" : "Connect"}
                </Button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel>
        <PanelHeader title="How this is wired" description="What is real today, and what OAuth would add" />
        <div className="space-y-3 border-t border-hairline p-4 text-[12.5px] leading-relaxed text-muted">
          <p>
            The data model is already the real one. <strong className="font-semibold text-body">{emailCount}</strong>{" "}
            messages and <strong className="font-semibold text-body">{eventCount}</strong> calendar events are
            stored in the same tables a live sync would write to, linked to contacts, companies, deals and
            projects, and driving the unanswered-thread detection and meeting panels you can see across the app.
          </p>
          <p>
            Both tables carry a unique <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[11px]">(provider, externalId)</code>{" "}
            constraint and the integration record holds a sync cursor, so a worker can upsert incrementally and
            re-run safely. Credentials have their own encrypted column rather than sitting in the environment.
          </p>
          <p>
            What is missing is the OAuth handshake and the polling worker — the connect buttons above are
            disabled because there is no client ID to hand them, not because the plumbing behind them is absent.
          </p>
        </div>
      </Panel>
    </div>
  );
}
