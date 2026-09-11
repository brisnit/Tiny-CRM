/**
 * Deterministic intelligence.
 *
 * Relationship strength, deal momentum and project health are *computed*, not
 * stored and not model-generated. That matters for three reasons: the numbers
 * stay correct when data changes, they cost nothing to display, and every score
 * can explain itself. Tiny AI reads these scores as input rather than
 * inventing its own — see src/lib/ai/context.ts.
 */
import { daysFromNowDateOnly, daysSince } from "@/lib/dates";

export type ScoreFactor = {
  label: string;
  detail: string;
  /** Positive lifts the score, negative drags it down. */
  impact: number;
};

export type Score<T extends string> = {
  value: T;
  /** 0-100. */
  score: number;
  factors: ScoreFactor[];
  summary: string;
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Relationship strength
// ---------------------------------------------------------------------------

export type RelationshipInput = {
  createdAt: Date | string;
  lastContactedAt?: Date | string | null;
  nextFollowUpAt?: Date | string | null;
  /** Interaction counts over the trailing 90 days. */
  meetings90d: number;
  emails90d: number;
  calls90d: number;
  /** Inbound replies over the trailing 90 days — evidence it is two-way. */
  inbound90d: number;
  openDealCount: number;
  openDealValueCents: number;
  /** Manual importance override, 0-100. */
  importance?: number | null;
};

export type RelationshipStrength = "strong" | "healthy" | "cooling" | "at_risk" | "new";

export function scoreRelationship(input: RelationshipInput): Score<RelationshipStrength> {
  const factors: ScoreFactor[] = [];
  let score = 40;

  const ageDays = daysSince(input.createdAt) ?? 0;
  const sinceContact = daysSince(input.lastContactedAt);
  const touches = input.meetings90d + input.emails90d + input.calls90d;

  // Not enough history to judge — say so rather than guess.
  if (ageDays < 21 && touches <= 2) {
    return {
      value: "new",
      score: 50,
      factors: [
        {
          label: "New relationship",
          detail: `Added ${ageDays} day${ageDays === 1 ? "" : "s"} ago with ${touches} interaction${touches === 1 ? "" : "s"} so far.`,
          impact: 0,
        },
      ],
      summary: "Too early to score. Keep the first few touches close together.",
    };
  }

  // Recency carries the most weight: a relationship is as warm as its last contact.
  if (sinceContact === null) {
    score -= 25;
    factors.push({
      label: "Never contacted",
      detail: "No logged interaction on this record yet.",
      impact: -25,
    });
  } else if (sinceContact <= 14) {
    score += 25;
    factors.push({
      label: "Recent contact",
      detail: `Last spoke ${sinceContact} day${sinceContact === 1 ? "" : "s"} ago.`,
      impact: 25,
    });
  } else if (sinceContact <= 30) {
    score += 10;
    factors.push({ label: "Contact within a month", detail: `Last spoke ${sinceContact} days ago.`, impact: 10 });
  } else if (sinceContact <= 60) {
    score -= 10;
    factors.push({ label: "Going quiet", detail: `${sinceContact} days since the last interaction.`, impact: -10 });
  } else {
    score -= 25;
    factors.push({ label: "Long silence", detail: `${sinceContact} days since the last interaction.`, impact: -25 });
  }

  // Frequency.
  if (touches >= 8) {
    score += 15;
    factors.push({ label: "Frequent contact", detail: `${touches} interactions in the last 90 days.`, impact: 15 });
  } else if (touches >= 3) {
    score += 8;
    factors.push({ label: "Steady contact", detail: `${touches} interactions in the last 90 days.`, impact: 8 });
  } else if (touches === 0) {
    score -= 12;
    factors.push({ label: "No recent activity", detail: "Nothing logged in the last 90 days.", impact: -12 });
  }

  // Meetings are worth more than emails.
  if (input.meetings90d > 0) {
    const impact = Math.min(12, input.meetings90d * 6);
    score += impact;
    factors.push({
      label: "Met in person or on a call",
      detail: `${input.meetings90d} meeting${input.meetings90d === 1 ? "" : "s"} in the last 90 days.`,
      impact,
    });
  }

  // Two-way beats one-way. A stream of outbound with no replies is not a
  // relationship, and this is where most CRMs flatter the user.
  const outbound = input.emails90d + input.calls90d;
  if (outbound >= 3) {
    const replyRate = input.inbound90d / outbound;
    if (replyRate >= 0.5) {
      score += 12;
      factors.push({
        label: "They reply",
        detail: `${Math.round(replyRate * 100)}% of your outreach gets a response.`,
        impact: 12,
      });
    } else if (replyRate < 0.2) {
      score -= 15;
      factors.push({
        label: "Mostly one-way",
        detail: `Only ${Math.round(replyRate * 100)}% of your outreach gets a response.`,
        impact: -15,
      });
    }
  }

  if (input.openDealCount > 0) {
    score += 8;
    factors.push({
      label: "Open opportunity",
      detail: `${input.openDealCount} open deal${input.openDealCount === 1 ? "" : "s"} in play.`,
      impact: 8,
    });
  }

  // An overdue follow-up on someone with open work is the sharpest signal.
  const followUp = daysFromNowDateOnly(input.nextFollowUpAt);
  if (followUp !== null && followUp < 0) {
    const impact = input.openDealCount > 0 ? -18 : -10;
    score += impact;
    factors.push({
      label: "Follow-up overdue",
      detail: `You planned to follow up ${Math.abs(followUp)} day${Math.abs(followUp) === 1 ? "" : "s"} ago.`,
      impact,
    });
  }

  if (ageDays > 365) {
    score += 5;
    factors.push({ label: "Long-standing", detail: `Known for ${Math.round(ageDays / 365)}+ years.`, impact: 5 });
  }

  if (typeof input.importance === "number") {
    // Manual importance nudges rather than overrides, so the score stays honest.
    const impact = Math.round((input.importance - 50) / 5);
    score += impact;
    if (impact !== 0) {
      factors.push({
        label: "Marked important",
        detail: "You flagged this relationship as a priority.",
        impact,
      });
    }
  }

  score = clamp(score);

  const value: RelationshipStrength =
    score >= 75 ? "strong" : score >= 55 ? "healthy" : score >= 35 ? "cooling" : "at_risk";

  const summary =
    value === "strong"
      ? "Warm and two-way. Keep the cadence."
      : value === "healthy"
        ? "In good shape. Nothing urgent here."
        : value === "cooling"
          ? "Contact has slowed. Worth a check-in this week."
          : "This one is slipping. Reach out before it goes cold.";

  return { value, score, factors: factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)), summary };
}

// ---------------------------------------------------------------------------
// Deal momentum & win probability
// ---------------------------------------------------------------------------

export type DealScoreInput = {
  createdAt: Date | string;
  stageEnteredAt: Date | string;
  lastActivityAt?: Date | string | null;
  expectedCloseAt?: Date | string | null;
  /** Stage position as a fraction of the pipeline, 0-1. */
  stageProgress: number;
  stageProbability: number;
  stageKind: "open" | "won" | "lost";
  valueCents: number;
  activities30d: number;
  inbound30d: number;
  meetings30d: number;
  openTasks: number;
  hasNextStep: boolean;
  contactCount: number;
};

export type Momentum = "high" | "steady" | "slowing" | "stalled";

export type DealIntelligence = {
  momentum: Score<Momentum>;
  /** Calibrated win probability, 0-100. */
  winProbability: number;
  risks: string[];
  recommendedAction: string;
};

export function scoreDeal(input: DealScoreInput): DealIntelligence {
  const factors: ScoreFactor[] = [];
  const risks: string[] = [];
  let momentumScore = 50;

  const sinceActivity = daysSince(input.lastActivityAt);
  const daysInStage = daysSince(input.stageEnteredAt) ?? 0;

  if (sinceActivity === null) {
    momentumScore -= 25;
    factors.push({ label: "No activity logged", detail: "Nothing has happened on this deal yet.", impact: -25 });
    risks.push("No activity has ever been logged on this deal.");
  } else if (sinceActivity <= 3) {
    momentumScore += 25;
    factors.push({ label: "Active this week", detail: `Last activity ${sinceActivity} day${sinceActivity === 1 ? "" : "s"} ago.`, impact: 25 });
  } else if (sinceActivity <= 10) {
    momentumScore += 10;
    factors.push({ label: "Recent activity", detail: `Last activity ${sinceActivity} days ago.`, impact: 10 });
  } else if (sinceActivity <= 21) {
    momentumScore -= 12;
    factors.push({ label: "Cooling off", detail: `${sinceActivity} days since anything happened.`, impact: -12 });
  } else {
    momentumScore -= 28;
    factors.push({ label: "Gone quiet", detail: `${sinceActivity} days since anything happened.`, impact: -28 });
    risks.push(`No activity for ${sinceActivity} days — this deal is going stale.`);
  }

  if (input.meetings30d > 0) {
    const impact = Math.min(15, input.meetings30d * 8);
    momentumScore += impact;
    factors.push({ label: "Meetings happening", detail: `${input.meetings30d} meeting${input.meetings30d === 1 ? "" : "s"} in the last 30 days.`, impact });
  }

  if (input.inbound30d > 0) {
    momentumScore += 12;
    factors.push({ label: "They are engaging", detail: `${input.inbound30d} inbound message${input.inbound30d === 1 ? "" : "s"} in the last 30 days.`, impact: 12 });
  } else if (input.activities30d >= 3) {
    momentumScore -= 10;
    factors.push({ label: "One-sided", detail: "You have been pushing without a response.", impact: -10 });
    risks.push("All recent activity is outbound — the buyer has gone silent.");
  }

  // Sitting in one stage is the classic stall signal.
  if (daysInStage > 45 && input.stageKind === "open") {
    momentumScore -= 20;
    factors.push({ label: "Stuck in stage", detail: `${daysInStage} days in the current stage.`, impact: -20 });
    risks.push(`Stuck in the same stage for ${daysInStage} days.`);
  } else if (daysInStage <= 10) {
    momentumScore += 8;
    factors.push({ label: "Moving through stages", detail: `Entered this stage ${daysInStage} day${daysInStage === 1 ? "" : "s"} ago.`, impact: 8 });
  }

  if (!input.hasNextStep && input.stageKind === "open") {
    momentumScore -= 8;
    factors.push({ label: "No next step", detail: "Nothing is scheduled to move this forward.", impact: -8 });
    risks.push("No next step is defined.");
  }

  if (input.openTasks === 0 && input.stageKind === "open") {
    risks.push("No open tasks — nobody is driving this.");
  }

  if (input.contactCount <= 1 && input.valueCents >= 2_500_000) {
    risks.push("Single-threaded on a large deal — only one contact is involved.");
    momentumScore -= 8;
    factors.push({ label: "Single-threaded", detail: "Only one contact is engaged on a high-value deal.", impact: -8 });
  }

  const closeIn = daysFromNowDateOnly(input.expectedCloseAt);
  if (closeIn !== null && closeIn < 0 && input.stageKind === "open") {
    momentumScore -= 15;
    factors.push({ label: "Past expected close", detail: `Expected close was ${Math.abs(closeIn)} days ago.`, impact: -15 });
    risks.push(`Expected close date passed ${Math.abs(closeIn)} days ago.`);
  }

  momentumScore = clamp(momentumScore);
  const momentumValue: Momentum =
    momentumScore >= 72 ? "high" : momentumScore >= 50 ? "steady" : momentumScore >= 30 ? "slowing" : "stalled";

  // Win probability starts from the stage's base rate and is adjusted by
  // momentum. Stage is the strongest predictor; behaviour refines it.
  let win = input.stageProbability;
  if (input.stageKind === "open") {
    const momentumAdjustment = (momentumScore - 50) * 0.4;
    win = clamp(win + momentumAdjustment, 2, 95);
    if (input.contactCount >= 3) win = clamp(win + 4, 2, 95);
  }

  const recommendedAction = recommendDealAction({
    momentum: momentumValue,
    sinceActivity,
    hasNextStep: input.hasNextStep,
    openTasks: input.openTasks,
    stageKind: input.stageKind,
    contactCount: input.contactCount,
    closeIn,
  });

  const summary =
    momentumValue === "high"
      ? "Everything is moving. Keep the pace and close the loop quickly."
      : momentumValue === "steady"
        ? "Progressing normally. Nothing alarming."
        : momentumValue === "slowing"
          ? "Losing pace. A concrete next step would help."
          : "This deal has stalled. It needs a deliberate re-engagement.";

  return {
    momentum: {
      value: momentumValue,
      score: momentumScore,
      factors: factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
      summary,
    },
    winProbability: Math.round(win),
    risks,
    recommendedAction,
  };
}

function recommendDealAction(args: {
  momentum: Momentum;
  sinceActivity: number | null;
  hasNextStep: boolean;
  openTasks: number;
  stageKind: "open" | "won" | "lost";
  contactCount: number;
  closeIn: number | null;
}) {
  if (args.stageKind === "won") return "Won. Turn this into a project and schedule the kickoff.";
  if (args.stageKind === "lost") return "Closed lost. Log the reason and set a re-engagement reminder for next quarter.";
  if (args.sinceActivity === null || args.sinceActivity > 21) {
    return "Send a direct re-engagement message today — reference the last thing you discussed and propose a specific time.";
  }
  if (!args.hasNextStep) return "Define the next step and put a date on it. Deals without one drift.";
  if (args.openTasks === 0) return "Create a task so this has an owner and a date.";
  if (args.contactCount <= 1) return "Bring a second contact into the conversation before the decision stage.";
  if (args.closeIn !== null && args.closeIn < 0) return "The close date has passed. Re-forecast it with the buyer rather than letting it slide.";
  if (args.momentum === "high") return "Keep momentum — schedule the next working session within 5 days.";
  return "Book a short call this week to confirm timing and decision criteria.";
}

// ---------------------------------------------------------------------------
// Project health
// ---------------------------------------------------------------------------

export type ProjectHealthInput = {
  targetDate?: Date | string | null;
  completedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  isTerminalStatus: boolean;
  overdueTasks: number;
  openTasks: number;
  totalMilestones: number;
  completedMilestones: number;
  overdueMilestones: number;
  budgetCents?: number | null;
  revenueCents?: number | null;
  hasNextAction: boolean;
};

export type ProjectHealth = "on_track" | "at_risk" | "off_track" | "on_hold";

export function scoreProjectHealth(input: ProjectHealthInput): Score<ProjectHealth> {
  if (input.isTerminalStatus || input.completedAt) {
    return {
      value: "on_track",
      score: 100,
      factors: [{ label: "Complete", detail: "This project has reached a terminal status.", impact: 0 }],
      summary: "Closed out.",
    };
  }

  const factors: ScoreFactor[] = [];
  let score = 70;

  const sinceActivity = daysSince(input.lastActivityAt);
  if (sinceActivity === null || sinceActivity > 21) {
    score -= 25;
    factors.push({
      label: "No recent activity",
      detail: sinceActivity === null ? "Nothing logged on this project yet." : `${sinceActivity} days since the last update.`,
      impact: -25,
    });
  } else if (sinceActivity <= 5) {
    score += 12;
    factors.push({ label: "Active", detail: `Updated ${sinceActivity} day${sinceActivity === 1 ? "" : "s"} ago.`, impact: 12 });
  }

  if (input.overdueTasks > 0) {
    const impact = -Math.min(30, input.overdueTasks * 8);
    score += impact;
    factors.push({
      label: "Overdue tasks",
      detail: `${input.overdueTasks} task${input.overdueTasks === 1 ? "" : "s"} past due.`,
      impact,
    });
  }

  if (input.overdueMilestones > 0) {
    const impact = -Math.min(25, input.overdueMilestones * 12);
    score += impact;
    factors.push({
      label: "Missed milestones",
      detail: `${input.overdueMilestones} milestone${input.overdueMilestones === 1 ? "" : "s"} past due.`,
      impact,
    });
  }

  const deadlineIn = daysFromNowDateOnly(input.targetDate);
  if (deadlineIn !== null) {
    if (deadlineIn < 0) {
      score -= 30;
      factors.push({ label: "Past deadline", detail: `Target date was ${Math.abs(deadlineIn)} days ago.`, impact: -30 });
    } else if (deadlineIn <= 14) {
      // Close to the deadline with lots of open work is the real risk signal.
      const remaining = input.totalMilestones - input.completedMilestones;
      if (input.openTasks > 4 || remaining > 1) {
        score -= 18;
        factors.push({
          label: "Deadline pressure",
          detail: `${deadlineIn} days left with ${input.openTasks} open task${input.openTasks === 1 ? "" : "s"}.`,
          impact: -18,
        });
      } else {
        factors.push({ label: "Deadline approaching", detail: `${deadlineIn} days left and work is nearly done.`, impact: 0 });
      }
    }
  }

  if (input.totalMilestones > 0) {
    const pct = input.completedMilestones / input.totalMilestones;
    if (pct >= 0.66) {
      score += 10;
      factors.push({ label: "Good progress", detail: `${input.completedMilestones} of ${input.totalMilestones} milestones done.`, impact: 10 });
    }
  }

  if (!input.hasNextAction) {
    score -= 8;
    factors.push({ label: "No next action", detail: "Nothing is defined as the next move.", impact: -8 });
  }

  if (input.budgetCents && input.revenueCents && input.revenueCents > input.budgetCents * 1.1) {
    score -= 12;
    factors.push({ label: "Over budget", detail: "Recorded revenue exceeds the budget by more than 10%.", impact: -12 });
  }

  score = clamp(score);
  const value: ProjectHealth = score >= 65 ? "on_track" : score >= 40 ? "at_risk" : "off_track";

  const summary =
    value === "on_track"
      ? "Moving as expected."
      : value === "at_risk"
        ? "Slipping. A few things need attention this week."
        : "Off track. This needs a deliberate reset.";

  return { value, score, factors: factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)), summary };
}
