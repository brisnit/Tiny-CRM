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

/**
 * What each connector does and whether it can be offered yet.
 *
 * `availability` is not cosmetic. Gmail read access needs a Google scope that
 * only clears review after an annual third-party security assessment, so it is
 * listed and explicitly unavailable rather than offered and then failing at the
 * consent screen. Saying so is more useful than a disabled button with no
 * reason.
 */
const PROVIDERS = [
  {
    id: "google_calendar",
    name: "Google Calendar",
    icon: Calendar,
    availability: "soon",
    blurb: "Bring meetings in and attach them to the right contact, company or project.",
  },
  {
    id: "outlook_calendar",
    name: "Outlook Calendar",
    icon: Calendar,
    availability: "soon",
    blurb: "The same, for Microsoft 365 calendars.",
  },
  {
    id: "outlook",
    name: "Outlook email",
    icon: Mail,
    availability: "soon",
    blurb: "Read-only. Imports threads and files them against the contact they are with.",
  },
  {
    id: "gmail",
    name: "Gmail",
    icon: Mail,
    availability: "blocked",
    blurb: "Read-only. Imports threads and files them against the contact they are with.",
  },
] as const;

const CONNECTED_TONE =
  "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900";

/**
 * Every stored status, in the words a customer should read.
 *
 * Keyed by the column's own values so an unrecognised one falls through to
 * "Not connected" rather than being rendered raw. `mock` is deliberately not
 * "Connected", not "Active" and not blank.
 */
const STATUS_LABEL: Record<string, string> = {
  none: "Not connected",
  connected: "Connected",
  disconnected: "Not connected",
  error: "Needs attention",
  reauth_required: "Reconnect needed",
  mock: "Demo data — not a real connection",
};

export default async function IntegrationSettings() {
  const actor = await requireActor();
  const read = await resolveReadScope(await readScope());

  const connected = await scopedRead(read, () =>
    db.integration.findMany({
      where: { workspaceId: { in: read.workspaceIds }, userId: actor.identity.id },
      select: { provider: true, status: true, accountEmail: true, lastSyncAt: true },
      distinct: ["provider"],
    }),
  );
  const byProvider = new Map(connected.map((c) => [c.provider, c]));

  const [emailCount, eventCount] = await scopedRead(read, () =>
    Promise.all([
      db.emailMessage.count({ where: { workspaceId: { in: read.workspaceIds } } }),
      db.calendarEvent.count({ where: { workspaceId: { in: read.workspaceIds } } }),
    ]),
  );

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Email & calendar"
          description="Bring your messages and meetings into Tiny CRM. Read-only."
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
                    {/*
                      The green tone is reserved for `connected`, which only a
                      real OAuth grant writes. `mock` is seeded demonstration
                      data and says so in plain words with no tone at all — a
                      status badge is the one place a customer will take at face
                      value, so it must not imply a connection that does not
                      exist. Any other stored status is shown through
                      STATUS_LABEL rather than printed raw, so an internal value
                      cannot leak into the interface.
                    */}
                    <Badge tone={state?.status === "connected" ? CONNECTED_TONE : undefined}>
                      {STATUS_LABEL[state?.status ?? "none"] ?? "Not connected"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{provider.blurb}</p>
                  {state?.accountEmail ? (
                    <p className="mt-1 text-[11.5px] text-faint">
                      {state.accountEmail} · last synced {timeAgo(state.lastSyncAt)}
                    </p>
                  ) : null}
                </div>
                {/*
                  Disabled with a reason attached, rather than a dead control.
                  "Connect" is not offered for a provider whose consent screen
                  would refuse — see `availability` on PROVIDERS.
                */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  title={
                    provider.availability === "blocked"
                      ? "Awaiting Google's review of restricted Gmail access"
                      : "Awaiting provider review — not yet available to connect"
                  }
                >
                  {provider.availability === "blocked" ? "Not yet available" : "Coming soon"}
                </Button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel>
        <PanelHeader
          title="What connecting does"
          description="Read-only in this release"
        />
        <div className="space-y-3 border-t border-hairline p-4 text-[12.5px] leading-relaxed text-muted">
          <p>
            Connecting brings your messages and meetings <strong className="font-semibold text-body">in</strong>.
            Tiny does not send email, create events or change anything in your mailbox or
            calendar — this release reads only.
          </p>
          <p>
            <strong className="font-semibold text-body">What you import stays yours.</strong>{" "}
            Imported mail and meetings are visible to you alone, even to people who share this
            workspace. They become visible to the workspace only when you attach one to a
            contact, company, deal or project yourself.
          </p>
          <p>
            <strong className="font-semibold text-body">Imported mail is not sent to Tiny AI.</strong>{" "}
            Connecting a mailbox is not permission to send your correspondence to a model
            provider, so imported messages and meetings are excluded from the daily brief,
            from answers and from everything else that leaves this server.
          </p>
          <p>
            You can disconnect at any time. Disconnecting stops any sync that is queued or
            already running, and asks you what to do with what has already been imported —
            nothing is deleted without you saying so.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Availability"
          description="Why some of these cannot be switched on yet"
        />
        <div className="space-y-3 border-t border-hairline p-4 text-[12.5px] leading-relaxed text-muted">
          <p>
            The four connectors above need an application registered with Google and with
            Microsoft, and each provider reviews that application before the public may grant
            it access. Calendar and Outlook mail need that review. Gmail additionally needs a
            scope Google classes as restricted, which it grants only after an annual
            independent security assessment, so Gmail will arrive after the others.
          </p>
          {emailCount + eventCount > 0 ? (
            <p>
              This workspace currently holds{" "}
              <strong className="font-semibold text-body">{emailCount}</strong>{" "}
              {emailCount === 1 ? "message" : "messages"} and{" "}
              <strong className="font-semibold text-body">{eventCount}</strong>{" "}
              {eventCount === 1 ? "meeting" : "meetings"} of seeded example data, so the
              contact and project pages have something to show. None of it came from a real
              mailbox, and it will not be mixed up with anything that does: imported records
              are marked as imported at the moment they arrive.
            </p>
          ) : null}
        </div>
      </Panel>

    </div>
  );
}
