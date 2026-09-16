import { dateOnlyInputValue } from "@/lib/dates";
import { isAwaitingDecision } from "@/lib/enums";

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
