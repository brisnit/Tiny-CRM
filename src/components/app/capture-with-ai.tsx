"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Building2, CalendarDays, CheckSquare, Landmark, Link2, Sparkles, Users, Wand2, X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/controls";
import { OptionSelect } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { analyzeText, applyProposals } from "@/lib/actions/ai";
import type { ClassificationResult, Proposal } from "@/lib/ai/classification";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ElementType> = {
  contact: Users,
  company: Building2,
  opportunity: Landmark,
  task: CheckSquare,
  date: CalendarDays,
  note: Sparkles,
};

const EXAMPLE =
  "Talked to Sarah at Fuller. She said the provost is interested and wants a demo next month. Need to send over the pricing this week.";

/**
 * Paste anything, get proposed CRM records back.
 *
 * The proposals are shown as a checklist and nothing is written until the user
 * confirms. That is the product's rule about never silently changing the CRM,
 * expressed as a UI.
 */
export function CaptureWithAi({
  workspaceId,
  workspaces,
}: {
  workspaceId: string | null;
  workspaces: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [target, setTarget] = React.useState(workspaceId ?? workspaces[0]?.id ?? "");
  const [result, setResult] = React.useState<ClassificationResult | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [analyzing, startAnalyze] = React.useTransition();
  const [applying, startApply] = React.useTransition();

  function analyze() {
    if (text.trim().length < 10) {
      toast.error("Write a little more so there is something to work with.");
      return;
    }
    startAnalyze(async () => {
      const response = await analyzeText(text);
      if (!response.ok) {
        toast.error(response.error);
        return;
      }
      setResult(response.data);
      setSelected(new Set(response.data.proposals.map((p) => p.id)));
      if (response.data.proposals.length === 0) {
        toast.info("Nothing specific found — you can still save it as a note.");
      }
    });
  }

  function apply() {
    if (!result || !target) return;
    const chosen = result.proposals.filter((p) => selected.has(p.id));
    startApply(async () => {
      const response = await applyProposals(target, chosen, text);
      if (!response.ok) {
        toast.error(response.error);
        return;
      }
      toast.success(
        response.data.created.length > 0
          ? `Created ${response.data.created.length} record${response.data.created.length === 1 ? "" : "s"}`
          : "Saved as a note",
      );
      setText("");
      setResult(null);
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-3 rounded-xl border border-dashed border-hairline-strong bg-panel px-4 py-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/30 dark:hover:bg-brand-950/20"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
          <Wand2 className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-body">Capture with Tiny AI</span>
          <span className="block truncate text-[12px] text-muted">
            Paste a call summary or an email — it finds the people, companies and next steps.
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-hairline bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Wand2 className="size-3.5 text-brand-500" />
          <h3 className="text-[13px] font-semibold text-body">Capture with Tiny AI</h3>
        </div>
        <button
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
          className="rounded-md p-1 text-faint transition-colors hover:bg-sunken hover:text-body"
          aria-label="Close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="space-y-3 p-4">
        <Textarea
          autoFocus
          rows={4}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          placeholder={EXAMPLE}
        />

        <div className="flex flex-wrap items-center gap-2">
          {workspaces.length > 1 ? (
            <OptionSelect
              size="sm"
              value={target}
              onValueChange={setTarget}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
              className="w-52"
            />
          ) : null}
          {!text ? (
            <button
              onClick={() => setText(EXAMPLE)}
              className="text-[12px] text-brand-600 hover:underline dark:text-brand-400"
            >
              Use the example
            </button>
          ) : null}
          <div className="ml-auto">
            <Button size="sm" variant="brand" onClick={analyze} loading={analyzing}>
              <Sparkles className="size-3.5" />
              Analyze
            </Button>
          </div>
        </div>

        {result ? (
          <div className="rounded-lg border border-hairline bg-sunken/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">
                Proposed changes
              </p>
              <Badge tone={sentimentTone(result.sentiment)}>{result.sentiment}</Badge>
              {!result.modelBacked ? (
                <span className="text-[11px] text-faint">Pattern matching · add an API key for more</span>
              ) : null}
            </div>

            {result.summary ? (
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{result.summary}</p>
            ) : null}

            {result.proposals.length === 0 ? (
              <p className="mt-3 text-[12.5px] text-muted">
                Nothing specific was found. Applying will still save this as a note.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {result.proposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    checked={selected.has(proposal.id)}
                    onToggle={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(proposal.id);
                        else next.delete(proposal.id);
                        return next;
                      })
                    }
                  />
                ))}
              </ul>
            )}

            <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline pt-3">
              <p className="text-[11.5px] text-faint">
                Nothing is saved until you approve it.
              </p>
              <Button size="sm" variant="brand" onClick={apply} loading={applying}>
                Apply {selected.size > 0 ? `${selected.size} change${selected.size === 1 ? "" : "s"}` : "as note"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProposalRow({
  proposal,
  checked,
  onToggle,
}: {
  proposal: Proposal;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const Icon = ICONS[proposal.kind] ?? Sparkles;
  return (
    <li>
      <label
        className={cn(
          "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-panel px-2.5 py-2 transition-colors",
          checked ? "border-brand-300 dark:border-brand-800" : "border-hairline",
        )}
      >
        <Checkbox checked={checked} onCheckedChange={(v) => onToggle(Boolean(v))} className="mt-0.5" />
        <Icon className="mt-0.5 size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-body">{proposal.label}</span>
          {proposal.detail ? (
            <span className="block text-[11.5px] text-muted">{proposal.detail}</span>
          ) : null}
        </span>
        {!proposal.isNew ? (
          <Badge className="shrink-0">
            <Link2 className="size-2.5" />
            Existing
          </Badge>
        ) : null}
      </label>
    </li>
  );
}

function sentimentTone(sentiment: string) {
  return sentiment === "positive"
    ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900"
    : sentiment === "negative"
      ? "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900"
      : "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700";
}
