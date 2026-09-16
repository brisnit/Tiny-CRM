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
  markOpportunitySubmitted, recordOpportunityOutcome, setOpportunityLifecycleState,
} from "@/lib/actions/opportunities";
import { dateOnlyInputValue } from "@/lib/dates";
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

  const today = dateOnlyInputValue(new Date()) ?? "";
  const [submittedOn, setSubmittedOn] = React.useState(
    () => dateOnlyInputValue(submittedAt) ?? today,
  );
  const [expectedOn, setExpectedOn] = React.useState(
    () => dateOnlyInputValue(decisionExpectedAt) ?? "",
  );
  const [decidedOn, setDecidedOn] = React.useState(today);

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
            <Field label="Decision expected" hint="Optional. Shown on the card while you wait.">
              <Input
                type="date"
                value={expectedOn}
                onChange={(event) => setExpectedOn(event.target.value)}
              />
            </Field>
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
                      decisionExpectedAt: expectedOn || null,
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
