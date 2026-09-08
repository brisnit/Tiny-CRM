import { Bot, Check, Sparkles, X } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/controls";
import { requireActor } from "@/lib/auth/access";
import { getPlanUsage } from "@/lib/entitlements";
import { describeProvider, isModelBacked } from "@/lib/ai/provider";
import { planFor, UNLIMITED } from "@/lib/plans";

export const metadata = { title: "Tiny AI" };

const CAPABILITIES = [
  { name: "Relationship strength", modelNeeded: false, detail: "Computed from contact recency, frequency, reply rate and open work." },
  { name: "Deal momentum & win probability", modelNeeded: false, detail: "Computed from stage, time in stage, engagement and next steps." },
  { name: "Project health", modelNeeded: false, detail: "Computed from overdue work, milestones and deadline pressure." },
  { name: "Duplicate & hygiene detection", modelNeeded: false, detail: "Exact SQL checks for duplicates, stale deals and missing links." },
  { name: "Daily brief", modelNeeded: false, detail: "Built from the same signals either way; a model writes it more naturally." },
  { name: "Record summaries", modelNeeded: false, detail: "Structured without a model; written in prose with one." },
  { name: "Open-ended questions", modelNeeded: true, detail: "Anything outside the built-in question patterns needs a model." },
  { name: "Entity extraction from pasted text", modelNeeded: true, detail: "Pattern matching finds the obvious cases; a model finds the rest." },
];

export default async function AiSettings() {
  const actor = await requireActor();
  const usage = await getPlanUsage(actor);
  const provider = describeProvider();
  const modelBacked = isModelBacked();
  const plan = planFor(actor.identity.plan);

  const limit = plan.limits.aiRequestsPerMonth;
  const pct = limit === UNLIMITED ? 0 : Math.min(100, Math.round((usage.aiRequestsPerMonth / limit) * 100));

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Model provider"
          description="Tiny AI is not tied to one vendor"
          icon={<Sparkles />}
          action={
            <Badge
              tone={
                modelBacked
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900"
                  : undefined
              }
            >
              {modelBacked ? "Connected" : "Built-in engine"}
            </Badge>
          }
        />
        <div className="space-y-3 border-t border-hairline p-4">
          <p className="text-[13px] text-body">
            Currently answering with <strong className="font-semibold">{provider.label}</strong>.
          </p>
          {modelBacked ? (
            <p className="text-[12.5px] leading-relaxed text-muted">
              Requests go to your own API account, so there is no AI surcharge on your subscription. Context is
              scoped to the workspaces you can see and capped before it is sent.
            </p>
          ) : (
            <>
              <p className="text-[12.5px] leading-relaxed text-muted">
                No API key is configured, so Tiny AI is running its built-in reasoning engine. Every score and
                every hygiene check below is exact either way — a model changes how answers are worded and lets
                you ask things outside the built-in patterns.
              </p>
              <div className="rounded-lg border border-hairline bg-sunken/60 p-3">
                <p className="text-[12px] font-medium text-body">Connecting a model</p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
                  During the private beta this is switched on for your account by us rather than
                  configured here. Everything below already works without it — the scores, the hygiene
                  checks and the daily brief are computed either way. A model changes how answers are
                  worded and lets you ask questions outside the built-in set.
                </p>
              </div>
            </>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Monthly usage" description={`${plan.name} plan`} />
        <div className="border-t border-hairline p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-body">Tiny AI requests this month</span>
            <span className="text-[13px] font-medium tabular text-body">
              {limit === UNLIMITED
                ? `${usage.aiRequestsPerMonth.toLocaleString()} · unlimited`
                : `${usage.aiRequestsPerMonth.toLocaleString()} / ${limit.toLocaleString()}`}
            </span>
          </div>
          {limit !== UNLIMITED ? <Progress value={pct} className="mt-2" /> : null}
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            Summaries are cached against a fingerprint of the record they describe, so re-opening a page costs
            nothing — a request is spent only when the underlying data has actually changed, or when you press
            refresh.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="What works without a model"
          description="Most of it, and exactly the same either way"
          icon={<Bot />}
        />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {CAPABILITIES.map((capability) => (
            <li key={capability.name} className="flex items-start gap-3 px-4 py-2.5">
              {capability.modelNeeded ? (
                <X className="mt-0.5 size-3.5 shrink-0 text-faint" />
              ) : (
                <Check className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-body">{capability.name}</span>
                <span className="block text-[12px] leading-relaxed text-muted">{capability.detail}</span>
              </span>
              {capability.modelNeeded ? <Badge>Needs a model</Badge> : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel>
        <PanelHeader title="Safety" description="How Tiny AI is allowed to touch your data" />
        <ul className="space-y-2.5 border-t border-hairline p-4">
          {[
            "It never writes to the CRM on its own. Extracted records are proposed as a checklist and applied only when you approve them.",
            "Context is assembled server-side and filtered to workspaces you already have access to. A model cannot widen its own scope.",
            "Context is capped and truncated, so prompt size does not grow with your database.",
            "Scores and risk assessments are computed by the application. The model explains them; it does not invent them.",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-muted">
              <Check className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
              {line}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
