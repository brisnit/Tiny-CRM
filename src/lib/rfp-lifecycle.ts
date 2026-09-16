import { dateOnlyInputValue, describeDateOnlyDeadline, formatDayOnly } from "@/lib/dates";
import { isAwaitingDecision, isTerminalSubmission } from "@/lib/enums";

/**
 * What a submission means for the dates around it.
 *
 * A submission deadline is a fact about the past once the proposal is in. Tiny
 * used to keep treating it as an outstanding obligation for ever, so an RFP
 * submitted on time went on reporting "1 day overdue" the morning after, and
 * the project it belonged to slid to At risk for having met its deadline.
 *
 * Nothing here rewrites a stored date. `proposalDeadlineAt` and
 * `Project.targetDate` stay exactly as they were captured; this decides how
 * they should be *read* now that the milestone they describe has been reached.
 *
 * One module, used by both the health score and the screens, so the badge and
 * the reason behind it can never disagree.
 */

/** The fields any caller must provide to reason about a submission. */
export type SubmissionFacts = {
  submissionStatus: string;
  submittedAt?: Date | string | null;
  proposalDeadlineAt?: Date | string | null;
  decisionExpectedAt?: Date | string | null;
  decidedAt?: Date | string | null;
};

/** An award or a rejection can only follow a submission; withdrawal need not. */
const OUTCOMES_IMPLYING_SUBMISSION = ["won", "lost"];

/**
 * Has this been submitted?
 *
 * A date is the best evidence, but not the only kind. The imported backlog
 * carries `submissionStatus: "submitted"` with no date, because the
 * spreadsheet never recorded one — those are genuinely submitted, and Tiny must
 * not keep calling them overdue for want of a timestamp it was never given. No
 * date is invented to fill the gap; see `submissionTiming`, which declines to
 * judge punctuality without one.
 */
export function isSubmitted(facts: SubmissionFacts): boolean {
  if (facts.submittedAt) return true;
  if (isAwaitingDecision(facts.submissionStatus)) return true;
  return OUTCOMES_IMPLYING_SUBMISSION.includes(facts.submissionStatus);
}

export type SubmissionTiming = {
  verdict: "early" | "on_time" | "late";
  /** Whole days between the submission and the deadline; negative is early. */
  days: number;
};

/**
 * Early, on time or late — or nothing at all.
 *
 * Needs both a submission date and a deadline, so the imported rows above are
 * excluded rather than guessed at. Only "late" is ever worth showing a person;
 * the rest is for counting later.
 */
export function submissionTiming(facts: SubmissionFacts): SubmissionTiming | null {
  if (!facts.submittedAt || !facts.proposalDeadlineAt) return null;
  const submitted = dateOnlyInputValue(facts.submittedAt);
  const deadline = dateOnlyInputValue(facts.proposalDeadlineAt);
  if (!submitted || !deadline) return null;

  const days = Math.round(
    (Date.parse(`${submitted}T00:00:00Z`) - Date.parse(`${deadline}T00:00:00Z`)) / 86_400_000,
  );
  if (days > 0) return { verdict: "late", days };
  return { verdict: days === 0 ? "on_time" : "early", days };
}

/** An opportunity as this module needs to see it. */
export type LinkedOpportunity = SubmissionFacts & { id: string; name?: string };

export type MetTarget = {
  opportunityId: string;
  submittedAt: Date | string | null;
  decisionExpectedAt: Date | string | null;
  decidedAt: Date | string | null;
  submissionStatus: string;
  /** Present only when both dates are known. */
  timing: SubmissionTiming | null;
};

/**
 * Was this project's target date met by a proposal going in?
 *
 * The match is deliberately narrow: the opportunity must be submitted **and**
 * its proposal deadline must fall on the same calendar day as the project's
 * target date. That sameness is the evidence that the project's date *is* the
 * RFP's submission deadline rather than a coincidence — without it, attaching
 * any submitted RFP to a project would silence real slippage on an unrelated
 * date, which is worse than the problem being fixed.
 *
 * Calendar days, not instants: a deadline is a day (see src/lib/dates.ts), and
 * comparing timestamps would shift the answer either side of midnight.
 */
export function meetsProjectTarget(
  targetDate: Date | string | null | undefined,
  opportunities: readonly LinkedOpportunity[],
): MetTarget | null {
  const target = targetDate ? dateOnlyInputValue(targetDate) : null;
  if (!target) return null;

  for (const opportunity of opportunities) {
    if (!isSubmitted(opportunity)) continue;
    const deadline = opportunity.proposalDeadlineAt
      ? dateOnlyInputValue(opportunity.proposalDeadlineAt)
      : null;
    if (!deadline || deadline !== target) continue;

    return {
      opportunityId: opportunity.id,
      submittedAt: opportunity.submittedAt ?? null,
      decisionExpectedAt: opportunity.decisionExpectedAt ?? null,
      decidedAt: opportunity.decidedAt ?? null,
      submissionStatus: opportunity.submissionStatus,
      timing: submissionTiming(opportunity),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// How a lifecycle reads
// ---------------------------------------------------------------------------

/**
 * What a surface should say about where this stands.
 *
 * One function, so the card, the detail page, the project it belongs to, the
 * home queues and Tiny AI cannot describe the same record differently. The
 * stored dates are never altered to make a line read better: a deadline that
 * was met is still shown as history wherever history belongs, and what changes
 * is only what the record is said to *owe*.
 */
export type LifecycleDisplay = {
  /** The headline: "Proposal Sep 15", "Submitted Sep 14", "Awarded Oct 8". */
  primary: string;
  /** What it means now: "1 day overdue", "Awaiting decision", "Decision expected Oct 8". */
  secondary: string | null;
  /** Only ever set when something is worth flagging — lateness, so far. */
  note: string | null;
  tone: "danger" | "warn" | "muted" | "positive";
  submitted: boolean;
};

const OUTCOME_LABEL: Record<string, string> = {
  won: "Awarded",
  lost: "Not awarded",
  withdrawn: "Withdrawn",
};

/** Whole days between two dates, by calendar day, or null when either is missing. */
function daysBetween(from?: Date | string | null, to?: Date | string | null): number | null {
  if (!from || !to) return null;
  const a = dateOnlyInputValue(from);
  const b = dateOnlyInputValue(to);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const plural = (n: number, word: string) => `${n} ${word}${Math.abs(n) === 1 ? "" : "s"}`;

/** How an opportunity reads, wherever it is shown. */
export function describeOpportunityLifecycle(
  facts: SubmissionFacts & { deadlineAt?: Date | string | null },
): LifecycleDisplay {
  const deadline = facts.proposalDeadlineAt ?? facts.deadlineAt ?? null;

  if (isTerminalSubmission(facts.submissionStatus)) {
    const label = OUTCOME_LABEL[facts.submissionStatus] ?? "Closed";
    const decided = facts.decidedAt ? formatDayOnly(facts.decidedAt) : null;
    const waited = daysBetween(facts.submittedAt, facts.decidedAt);
    return {
      primary: decided ? `${label} ${decided}` : label,
      secondary: waited !== null && waited >= 0 ? `${plural(waited, "day")} after submission` : null,
      note: null,
      tone: facts.submissionStatus === "won" ? "positive" : "muted",
      submitted: isSubmitted(facts),
    };
  }

  if (isSubmitted(facts)) {
    // An imported row may be submitted with no date. It says so plainly rather
    // than borrowing a date from somewhere it does not belong.
    const when = facts.submittedAt ? formatDayOnly(facts.submittedAt) : null;
    const timing = submissionTiming(facts);
    const late = timing?.verdict === "late" ? timing.days : null;
    return {
      primary: when ? `Submitted ${when}` : "Submitted",
      secondary: facts.decisionExpectedAt
        ? `Decision expected ${formatDayOnly(facts.decisionExpectedAt)}`
        : "Awaiting decision",
      // Early and on time are unremarkable; only lateness is worth a word.
      note: late !== null ? `${plural(late, "day")} after the deadline` : null,
      tone: late !== null ? "warn" : "muted",
      submitted: true,
    };
  }

  const described = describeDateOnlyDeadline(deadline ?? null);
  return {
    primary: deadline ? `Proposal ${formatDayOnly(deadline)}` : "No deadline set",
    secondary: deadline ? described.label : null,
    note: null,
    tone: described.overdue ? "danger" : described.urgent ? "warn" : "muted",
    submitted: false,
  };
}

/**
 * How a project's target date reads, given what met it.
 *
 * The date itself is unchanged and still shown wherever the record's history
 * is shown. This decides whether it is still something owed.
 */
export function describeProjectTarget(
  targetDate: Date | string | null | undefined,
  met: MetTarget | null,
): LifecycleDisplay {
  if (met) {
    const when = met.submittedAt ? formatDayOnly(met.submittedAt) : null;
    const late = met.timing?.verdict === "late" ? met.timing.days : null;
    return {
      primary: when ? `Submitted ${when}` : "Submitted",
      secondary: met.decisionExpectedAt
        ? `Decision expected ${formatDayOnly(met.decisionExpectedAt)}`
        : "Awaiting decision",
      note: late !== null ? `${plural(late, "day")} after the deadline` : null,
      tone: late !== null ? "warn" : "positive",
      submitted: true,
    };
  }

  const described = describeDateOnlyDeadline(targetDate ?? null);
  return {
    primary: targetDate ? formatDayOnly(targetDate) : "No deadline",
    secondary: targetDate ? described.label : null,
    note: null,
    tone: described.overdue ? "danger" : described.urgent ? "warn" : "muted",
    submitted: false,
  };
}
