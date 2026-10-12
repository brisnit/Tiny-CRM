import { Calendar, Mail, Plug } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { scopedRead } from "@/lib/data/scoped";
import { integrationsEnabled } from "@/lib/integrations/gate";
import { isConfigured, isOfferable, PROVIDERS } from "@/lib/integrations/providers";
import { CALLBACK_MESSAGES, summarise, type ConnectionView } from "@/lib/integrations/status";
import { DisconnectControl } from "@/components/app/integrations/disconnect-control";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const ICONS = { email: Mail, calendar: Calendar } as const;

const TONES: Record<string, string | undefined> = {
  connected:
    "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  attention:
    "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  demo: undefined,
  none: undefined,
};

export default async function IntegrationSettings({
  searchParams,
}: {
  searchParams: Promise<{ connection?: string }>;
}) {
  const actor = await requireActor();
  const read = await resolveReadScope(await readScope());
  const params = await searchParams;
  const banner = params.connection ? CALLBACK_MESSAGES[params.connection] : undefined;

  // One workspace owns a connection, and it has to be an explicit one rather
  // than "whichever is first". With a single workspace in scope that is
  // unambiguous; with several, the connection belongs to the one being viewed.
  const workspaceId = read.workspaceIds[0] ?? null;

  const [connections, available] = await scopedRead(read, async () => [
    await db.integration.findMany({
      where: { workspaceId: { in: read.workspaceIds }, userId: actor.identity.id },
      select: {
        provider: true, status: true, accountEmail: true, lastSyncAt: true,
        syncState: true, backfillCompletedAt: true, lastError: true,
      },
    }),
    workspaceId ? await integrationsEnabled(workspaceId) : false,
  ]);

  const byProvider = new Map<string, ConnectionView>(
    connections.map((c) => [c.provider, c as ConnectionView]),
  );

  return (
    <div className="space-y-5">
      {banner ? (
        <Panel>
          <p
            className={`p-4 text-[13px] leading-relaxed ${
              banner.tone === "ok" ? "text-body" : "text-amber-800 dark:text-amber-300"
            }`}
          >
            {banner.text}
          </p>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader
          title="Email & calendar"
          description="Bring your messages and meetings into Tiny CRM. Read-only."
          icon={<Plug />}
        />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {Object.values(PROVIDERS).map((provider) => {
            const Icon = ICONS[provider.kind];
            const state = summarise(byProvider.get(provider.id) ?? null);
            const connection = byProvider.get(provider.id);
            const offerable = isOfferable(provider);
            const configured = isConfigured(provider);

            return (
              <li key={provider.id} className="flex flex-wrap items-start gap-3 px-4 py-3.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-faint">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13.5px] font-semibold text-body">{provider.label}</p>
                    <Badge tone={TONES[state.tone]}>{state.label}</Badge>
                  </div>
                  {connection?.accountEmail ? (
                    <p className="mt-1 text-[11.5px] text-faint">{connection.accountEmail}</p>
                  ) : null}
                  {/*
                    The second line exists so "Connected" cannot be read as
                    "your mail is in here". See src/lib/integrations/status.ts.
                  */}
                  {state.importLine ? (
                    <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{state.importLine}</p>
                  ) : (
                    <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{provider.blurb}</p>
                  )}
                  {state.problem ? (
                    <p className="mt-1 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
                      {state.problem}
                    </p>
                  ) : null}
                  {!offerable ? (
                    <p className="mt-1 text-[12px] leading-relaxed text-faint">
                      {provider.blockedReason}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {state.canDisconnect ? (
                    <DisconnectControl provider={provider.id} label={provider.label} />
                  ) : null}
                  {state.canConnect ? (
                    offerable && configured && available ? (
                      <form method="post" action={`/api/integrations/${provider.vendor}/start`}>
                        <input type="hidden" name="provider" value={provider.id} />
                        <input type="hidden" name="workspaceId" value={workspaceId ?? ""} />
                        <Button size="sm" variant="outline" type="submit">
                          {connection ? "Reconnect" : "Connect"}
                        </Button>
                      </form>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        title={
                          !offerable
                            ? "Awaiting the provider's review"
                            : !configured
                              ? "This environment has no credentials for that provider"
                              : "Not switched on for this workspace"
                        }
                      >
                        {offerable ? "Unavailable" : "Not yet available"}
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel>
        <PanelHeader title="What connecting does" description="Read-only in this release" />
        <div className="space-y-3 border-t border-hairline p-4 text-[12.5px] leading-relaxed text-muted">
          <p>
            Connecting brings your messages and meetings <strong className="font-semibold text-body">in</strong>.
            Tiny does not send email, create events or change anything in your mailbox or calendar.
          </p>
          <p>
            <strong className="font-semibold text-body">Connecting is not importing.</strong> Granting
            access lets Tiny read; it does not move anything by itself. Each connection above says
            whether anything has been imported yet, and nothing has until it says so.
          </p>
          <p>
            <strong className="font-semibold text-body">What you import stays yours.</strong> Imported
            mail and meetings are visible to you alone, even to people who share this workspace. They
            become visible to the workspace only when you attach one to a contact, company, deal or
            project yourself.
          </p>
          <p>
            <strong className="font-semibold text-body">Imported mail is not sent to Tiny AI.</strong>{" "}
            Connecting a mailbox is not permission to send your correspondence to a model provider, so
            imported messages and meetings are excluded from the daily brief, from answers and from
            everything else that leaves this server.
          </p>
          <p>
            Disconnecting destroys the stored access immediately and stops any import that is queued or
            already running. It asks what to do with anything already imported — nothing is deleted
            unless you say so.
          </p>
        </div>
      </Panel>
    </div>
  );
}
