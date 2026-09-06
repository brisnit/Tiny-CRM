import { CheckCircle2, Workflow, XCircle } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { AutomationToggle } from "@/components/app/automation-toggle";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { timeAgo } from "@/lib/dates";
import { AUTOMATION_ACTION, AUTOMATION_TRIGGER } from "@/lib/enums";

export const metadata = { title: "Automations" };

type Action = { type: string; title?: string; message?: string; items?: string[]; dueInDays?: number; tag?: string };
type Condition = { field: string; op: string; value: unknown };

export default async function AutomationsPage() {
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const workspaces = actor.memberships;
  const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));

  const automations = await db.automation.findMany({
    where: { workspaceId: { in: workspaceIds } },
    include: {
      runs: { orderBy: { createdAt: "desc" }, take: 3 },
    },
    orderBy: [{ enabled: "desc" }, { name: "asc" }],
  });

  const totalRuns = automations.reduce((sum, a) => sum + a.runCount, 0);

  return (
    <PageShell>
      <PageHeader
        title="Automations"
        description="Small rules that keep the CRM tidy without you thinking about it."
      />

      {automations.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Workflow />}
            title="No automations yet"
            description="A rule is a trigger, some conditions and an action — like creating a follow-up task three days after a deal reaches Proposal."
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">
            {automations.filter((a) => a.enabled).length} of {automations.length} enabled ·{" "}
            {totalRuns.toLocaleString()} run{totalRuns === 1 ? "" : "s"} so far
          </p>

          <div className="space-y-3">
            {automations.map((automation) => {
              const actions = parseJson<Action[]>(automation.actions, []);
              const conditions = parseJson<Condition[]>(automation.conditions, []);

              return (
                <Panel key={automation.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-body">
                          {automation.name}
                        </h3>
                        <Badge>{workspaceNames.get(automation.workspaceId) ?? ""}</Badge>
                      </div>
                      {automation.description ? (
                        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{automation.description}</p>
                      ) : null}
                    </div>
                    <AutomationToggle id={automation.id} enabled={automation.enabled} />
                  </div>

                  <div className="grid gap-px border-t border-hairline bg-hairline sm:grid-cols-3">
                    <div className="bg-panel p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">When</p>
                      <p className="mt-1.5 text-[13px] leading-snug text-body">
                        {AUTOMATION_TRIGGER.label(automation.trigger, automation.trigger)}
                      </p>
                    </div>
                    <div className="bg-panel p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">And</p>
                      {conditions.length === 0 ? (
                        <p className="mt-1.5 text-[13px] text-muted">No conditions — always runs.</p>
                      ) : (
                        <ul className="mt-1.5 space-y-1">
                          {conditions.map((condition, i) => (
                            <li key={i} className="text-[13px] leading-snug text-body">
                              <span className="text-muted">{humanField(condition.field)}</span>{" "}
                              {humanOp(condition.op)}{" "}
                              <span className="font-medium">{String(condition.value)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="bg-panel p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Then</p>
                      <ul className="mt-1.5 space-y-1">
                        {actions.map((action, i) => (
                          <li key={i} className="text-[13px] leading-snug text-body">
                            {describeAction(action)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline px-4 py-2.5 text-[11.5px] text-faint">
                    <span>{automation.runCount} run{automation.runCount === 1 ? "" : "s"}</span>
                    <span>Last ran {timeAgo(automation.lastRunAt)}</span>
                    {automation.runs.length > 0 ? (
                      <span className="flex items-center gap-2">
                        {automation.runs.map((run) => (
                          <span key={run.id} className="inline-flex items-center gap-1">
                            {run.status === "success" ? (
                              <CheckCircle2 className="size-3 text-emerald-500" />
                            ) : run.status === "error" ? (
                              <XCircle className="size-3 text-rose-500" />
                            ) : (
                              <span className="size-1.5 rounded-full bg-hairline-strong" />
                            )}
                            {run.message ? <span className="truncate">{run.message}</span> : null}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </Panel>
              );
            })}
          </div>

          <Panel>
            <PanelHeader
              title="How this works"
              description="Rules run inline on the write that triggers them"
            />
            <div className="border-t border-hairline p-4">
              <p className="text-[12.5px] leading-relaxed text-muted">
                Stage changes and status changes fire their automations as part of the same request, so the
                follow-up task exists by the time the page reloads. Time-based triggers — deadlines approaching, a
                deal going quiet — are evaluated by the same engine, which is designed to be called from a
                scheduled job as the workspace grows.
              </p>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted">
                Available actions:{" "}
                {AUTOMATION_ACTION.options.map((option) => option.label.toLowerCase()).join(", ")}.
              </p>
            </div>
          </Panel>
        </div>
      )}
    </PageShell>
  );
}

function humanField(field: string) {
  return field
    .replace(/\./g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function humanOp(op: string) {
  return (
    { equals: "is", not_equals: "is not", contains: "contains", gte: "is at least", lte: "is at most", in: "is one of" }[
      op
    ] ?? op
  );
}

function describeAction(action: Action) {
  switch (action.type) {
    case "create_task":
      return `Create a task “${action.title}”${action.dueInDays !== undefined ? `, due in ${action.dueInDays} day${action.dueInDays === 1 ? "" : "s"}` : ""}`;
    case "create_checklist":
      return `Create a ${action.items?.length ?? 0}-item checklist`;
    case "notify_owner":
      return `Notify the owner: “${action.message}”`;
    case "set_health":
      return "Set the project health";
    case "add_tag":
      return `Add the tag “${action.tag}”`;
    default:
      return action.type;
  }
}
