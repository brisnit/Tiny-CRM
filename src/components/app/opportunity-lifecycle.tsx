"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  markOpportunitySubmitted, recordOpportunityOutcome, setOpportunityDecisionExpected,
  setOpportunityLifecycleState,
} from "@/lib/actions/opportunities";
import { dateOnlyInputValue, todayDateOnlyInputValue } from "@/lib/dates";
import { isAwaitingDecision, isTerminalSubmission } from "@/lib/enums";

/**
 * Moving an RFP through its lifecycle.
 *
 * The common case is one button. Marking something submitted is the moment the
 * deadline stops being an obligation, and it happens far more often than any
 * other transition here, so it is a single primary action with today already
 * filled in — editable, because submissions get recorded after the fact.
 *
 * Everything after submission is a fact about somebody else's process. Tiny
 * cannot see a buyer's shortlist and will not infer one from a calendar, so
 * under review and shortlisted are chosen by a person, never derived. The
 * endings ask for a date for the same reason the submission does: the gap
 * between submitting and hearing back is worth knowing later.
 *
 * The pipeline moves itself where the workspace has a matching stage — that
 * guard lives on the server, which also owns authorization and the audit trail.
 */

type Outcome = "won" | "lost" | "withdrawn";

/**
 * When we expect to hear back, including not knowing.
 *
 * Most buyers never name a date, so "Unknown" is offered as an answer rather
 * than left as the empty field you get for skipping the question. It is also
 * the honest default: a date typed to fill a blank would read later like
 * something the buyer told us.
 */
function ExpectedDecision({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const known = value !== null;
  const inputId = React.useId();

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1.5 block text-[12.5px] font-medium text-secondary">
        Decision expected
      </legend>
      <div className="flex gap-4">
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="radio"
            name={`expected-${inputId}`}
            className="size-3.5 accent-current"
            checked={!known}
            onChange={() => onChange(null)}
          />
          Unknown
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="radio"
            name={`expected-${inputId}`}
            className="size-3.5 accent-current"
            checked={known}
            onChange={() => onChange(todayDateOnlyInputValue())}
          />
          On a date
        </label>
      </div>
      {known ? (
        <Input
          type="date"
          aria-label="Expected decision date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <p className="text-[11.5px] text-faint">
          Tiny will say “Awaiting decision” and leave it at that — no deadline, no chasing.
        </p>
      )}
    </fieldset>
  );
}

const OUTCOMES: { value: Outcome; label: string; description: string }[] = [
  { value: "won", label: "Awarded", description: "We won it." },
  { value: "lost", label: "Not awarded", description: "It went elsewhere." },
  { value: "withdrawn", label: "Withdrawn", description: "We stepped away from the pursuit." },
];

export function OpportunityLifecycle({
  id,
  submissionStatus,
  version,
  submittedAt,
  decisionExpectedAt,
}: {
  id: string;
  submissionStatus: string;
  version: number;
  submittedAt: Date | string | null;
  decisionExpectedAt: Date | string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  // dateOnlyInputValue returns "" for an absent date, never null, so these fall
  // back with || rather than ??. With ?? the "defaults to today" below silently
  // became an empty field and a disabled button.
  const today = todayDateOnlyInputValue();
  const [submittedOn, setSubmittedOn] = React.useState(
    () => dateOnlyInputValue(submittedAt) || today,
  );
  // null is "unknown", a string is a chosen date — the distinction the record
  // itself keeps, rather than an empty input standing in for both.
  const [expectedOn, setExpectedOn] = React.useState<string | null>(
    () => dateOnlyInputValue(decisionExpectedAt) || null,
  );
  const [decidedOn, setDecidedOn] = React.useState(today);
  const [expectedOpen, setExpectedOpen] = React.useState(false);

  const settled = isTerminalSubmission(submissionStatus);
  const awaiting = isAwaitingDecision(submissionStatus);

  /** Runs an action, reports what happened, and refreshes the record. */
  function run(
    work: () => Promise<{ ok: boolean; error?: string; data?: unknown }>,
    success: string,
    onDone?: () => void,
  ) {
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        toast.error(result.error ?? "That did not save.");
        return;
      }
      // Only some transitions can move a stage, and only when the workspace has
      // one by that name — so this is read defensively rather than required.
      const moved = (result.data as { stageMovedTo?: string | null } | undefined)?.stageMovedTo;
      toast.success(moved ? `${success} · moved to ${moved}` : success);
      onDone?.();
      router.refresh();
    });
  }

  return (
    <>
      {!settled && !awaiting ? (
        <Button size="sm" onClick={() => setSubmitOpen(true)} disabled={pending}>
          <Check className="size-3.5" />
          Mark submitted
        </Button>
      ) : null}

      {awaiting ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={pending}>
              Update status
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {submissionStatus !== "under_review" ? (
              <DropdownMenuItem
                onSelect={() =>
                  run(
                    () => setOpportunityLifecycleState(id, { status: "under_review", version }),
                    "Marked under review",
                  )
                }
              >
                Under review
              </DropdownMenuItem>
            ) : null}
            {submissionStatus !== "shortlisted" ? (
              <DropdownMenuItem
                onSelect={() =>
                  run(
                    () => setOpportunityLifecycleState(id, { status: "shortlisted", version }),
                    "Marked shortlisted",
                  )
                }
              >
                Shortlisted
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => setExpectedOpen(true)}>
              Decision expected…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {OUTCOMES.map((option) => (
              <DropdownMenuItem key={option.value} onSelect={() => setOutcome(option.value)}>
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* Mark submitted */}
      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark submitted</DialogTitle>
            <DialogDescription>
              The submission deadline stays on the record as history. From here Tiny stops
              treating it as something still owed.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Field label="Submitted" hint="Defaults to today. Change it if this went in earlier.">
              <Input
                type="date"
                value={submittedOn}
                onChange={(event) => setSubmittedOn(event.target.value)}
              />
            </Field>
            <ExpectedDecision value={expectedOn} onChange={setExpectedOn} disabled={pending} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSubmitOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              disabled={pending || !submittedOn}
              onClick={() =>
                run(
                  () =>
                    markOpportunitySubmitted(id, {
                      submittedAt: submittedOn,
                      decisionExpectedAt: expectedOn,
                      version,
                    }),
                  "Marked submitted",
                  () => setSubmitOpen(false),
                )
              }
            >
              {pending ? "Saving…" : "Mark submitted"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* When we expect to hear back — changeable in both directions */}
      <Dialog
        open={expectedOpen}
        onOpenChange={(open) => {
          setExpectedOpen(open);
          // Reopening should show what is stored, not what was typed and abandoned.
          if (!open) setExpectedOn(dateOnlyInputValue(decisionExpectedAt) || null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decision expected</DialogTitle>
            <DialogDescription>
              When the buyer has said when they will decide. Unknown is a fine answer, and
              the usual one — it changes nothing about how Tiny treats the proposal.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ExpectedDecision value={expectedOn} onChange={setExpectedOn} disabled={pending} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExpectedOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              disabled={pending || expectedOn === ""}
              onClick={() =>
                run(
                  () =>
                    setOpportunityDecisionExpected(id, {
                      decisionExpectedAt: expectedOn,
                      version,
                    }),
                  expectedOn ? "Decision date saved" : "Decision date set to unknown",
                  () => setExpectedOpen(false),
                )
              }
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* An ending */}
      <Dialog open={outcome !== null} onOpenChange={(open) => !open && setOutcome(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{OUTCOMES.find((o) => o.value === outcome)?.label ?? "Outcome"}</DialogTitle>
            <DialogDescription>
              {OUTCOMES.find((o) => o.value === outcome)?.description}{" "}
              The date is kept so Tiny can tell you how long decisions take.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Decided" hint="Defaults to today.">
              <Input
                type="date"
                value={decidedOn}
                onChange={(event) => setDecidedOn(event.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOutcome(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              disabled={pending || !outcome}
              onClick={() =>
                run(
                  () =>
                    recordOpportunityOutcome(id, {
                      outcome: outcome as Outcome,
                      decidedAt: decidedOn,
                      version,
                    }),
                  "Outcome recorded",
                  () => setOutcome(null),
                )
              }
            >
              {pending ? "Saving…" : "Record it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
