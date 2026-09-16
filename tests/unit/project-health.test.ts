import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scoreProjectHealth, type ProjectHealthInput } from "../../src/lib/scoring";

/**
 * What project health is, today.
 *
 * This is a characterisation suite: it was written before the RFP lifecycle
 * work changed anything, and it pins the arithmetic as it already behaves —
 * every factor, its exact impact, the bands, the summaries and the ordering.
 * The scorer had no tests at all, and the lifecycle change alters two of its
 * factors ("Past deadline" and "Deadline pressure"), so without this there
 * would be nothing to measure that change against.
 *
 * The numbers below are therefore deliberate, not incidental. A failure here
 * means the scoring moved; decide whether that was intended before editing the
 * expectation.
 *
 * Base score is 70. The neutral project used throughout is active (updated two
 * days ago, +12), has no deadline, no milestones, a next action and no budget —
 * so it sits at 82, comfortably "on track".
 */

/** Local noon N days away, so a date-only comparison cannot land on a boundary. */
function daysAway(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date;
}

const base: ProjectHealthInput = {
  targetDate: null,
  completedAt: null,
  lastActivityAt: new Date(Date.now() - 2 * 86_400_000),
  isTerminalStatus: false,
  overdueTasks: 0,
  openTasks: 2,
  totalMilestones: 0,
  completedMilestones: 0,
  overdueMilestones: 0,
  budgetCents: null,
  revenueCents: null,
  hasNextAction: true,
};

/** The factor with this label, or undefined. */
const factor = (result: ReturnType<typeof scoreProjectHealth>, label: string) =>
  result.factors.find((f) => f.label === label);

describe("project health, as it scores today", () => {
  test("the neutral project: base 70, +12 for recent activity", () => {
    const result = scoreProjectHealth(base);
    assert.equal(result.score, 82);
    assert.equal(result.value, "on_track");
    assert.equal(result.summary, "Moving as expected.");
    assert.equal(factor(result, "Active")?.impact, 12);
  });

  test("a terminal status short-circuits everything, including a passed deadline", () => {
    // The one piece of lifecycle awareness the scorer already has: a closed-out
    // project is not judged on its dates.
    const result = scoreProjectHealth({
      ...base,
      isTerminalStatus: true,
      targetDate: daysAway(-40),
      overdueTasks: 9,
    });
    assert.equal(result.score, 100);
    assert.equal(result.value, "on_track");
    assert.equal(result.summary, "Closed out.");
    assert.deepEqual(result.factors.map((f) => f.label), ["Complete"]);
  });

  test("completedAt does the same, without a terminal status", () => {
    const result = scoreProjectHealth({ ...base, completedAt: daysAway(-3), targetDate: daysAway(-40) });
    assert.equal(result.score, 100);
    assert.equal(result.value, "on_track");
  });

  describe("activity", () => {
    test("nothing logged at all costs 25", () => {
      const result = scoreProjectHealth({ ...base, lastActivityAt: null });
      assert.equal(result.score, 45);
      assert.equal(result.value, "at_risk");
      assert.equal(factor(result, "No recent activity")?.detail, "Nothing logged on this project yet.");
    });

    test("more than 21 days quiet costs 25, and says how long", () => {
      const result = scoreProjectHealth({ ...base, lastActivityAt: new Date(Date.now() - 30 * 86_400_000) });
      assert.equal(result.score, 45);
      assert.equal(factor(result, "No recent activity")?.detail, "30 days since the last update.");
    });

    test("between 6 and 21 days is neither rewarded nor punished", () => {
      const result = scoreProjectHealth({ ...base, lastActivityAt: new Date(Date.now() - 10 * 86_400_000) });
      assert.equal(result.score, 70);
      assert.equal(factor(result, "Active"), undefined);
      assert.equal(factor(result, "No recent activity"), undefined);
    });
  });

  describe("open work", () => {
    test("overdue tasks cost 8 each", () => {
      const result = scoreProjectHealth({ ...base, overdueTasks: 2, openTasks: 4 });
      assert.equal(factor(result, "Overdue tasks")?.impact, -16);
      assert.equal(result.score, 66);
    });

    test("and are capped at 30", () => {
      const result = scoreProjectHealth({ ...base, overdueTasks: 9, openTasks: 9 });
      assert.equal(factor(result, "Overdue tasks")?.impact, -30);
      assert.equal(result.score, 52);
      assert.equal(result.value, "at_risk");
    });

    test("overdue milestones cost 12 each, capped at 25", () => {
      const two = scoreProjectHealth({ ...base, totalMilestones: 4, overdueMilestones: 2 });
      assert.equal(factor(two, "Missed milestones")?.impact, -24);
      const three = scoreProjectHealth({ ...base, totalMilestones: 4, overdueMilestones: 3 });
      assert.equal(factor(three, "Missed milestones")?.impact, -25);
    });

    test("finishing two thirds of the milestones earns 10", () => {
      const result = scoreProjectHealth({ ...base, totalMilestones: 3, completedMilestones: 2 });
      assert.equal(factor(result, "Good progress")?.impact, 10);
      assert.equal(result.score, 92);
    });

    test("no next action costs 8", () => {
      const result = scoreProjectHealth({ ...base, hasNextAction: false });
      assert.equal(factor(result, "No next action")?.impact, -8);
      assert.equal(result.score, 74);
    });

    test("revenue more than 10% over budget costs 12", () => {
      const result = scoreProjectHealth({ ...base, budgetCents: 100_000, revenueCents: 120_000 });
      assert.equal(factor(result, "Over budget")?.impact, -12);
      const within = scoreProjectHealth({ ...base, budgetCents: 100_000, revenueCents: 105_000 });
      assert.equal(factor(within, "Over budget"), undefined);
    });
  });

  describe("the deadline factors — the two the RFP lifecycle work will change", () => {
    test("a passed target date costs 30, and drags an otherwise healthy project to at risk", () => {
      // This is the defect the lifecycle work addresses: the penalty is applied
      // from the date alone, with no notion of whether the obligation was met.
      const result = scoreProjectHealth({ ...base, targetDate: daysAway(-10) });
      assert.equal(factor(result, "Past deadline")?.impact, -30);
      assert.equal(factor(result, "Past deadline")?.detail, "Target date was 10 days ago.");
      assert.equal(result.score, 52);
      assert.equal(result.value, "at_risk");
      assert.equal(result.summary, "Slipping. A few things need attention this week.");
    });

    test("within 14 days and busy costs 18", () => {
      const result = scoreProjectHealth({ ...base, targetDate: daysAway(7), openTasks: 6 });
      assert.equal(factor(result, "Deadline pressure")?.impact, -18);
      assert.equal(factor(result, "Deadline pressure")?.detail, "7 days left with 6 open tasks.");
      assert.equal(result.score, 64);
      assert.equal(result.value, "at_risk");
    });

    test("within 14 days with more than one milestone left also counts as pressure", () => {
      const result = scoreProjectHealth({
        ...base, targetDate: daysAway(7), openTasks: 1, totalMilestones: 4, completedMilestones: 1,
      });
      assert.equal(factor(result, "Deadline pressure")?.impact, -18);
    });

    test("within 14 days with the work nearly done is noted, not punished", () => {
      const result = scoreProjectHealth({ ...base, targetDate: daysAway(7) });
      assert.equal(factor(result, "Deadline approaching")?.impact, 0);
      assert.equal(result.score, 82);
      assert.equal(result.value, "on_track");
    });

    test("a deadline further out than 14 days is not mentioned at all", () => {
      const result = scoreProjectHealth({ ...base, targetDate: daysAway(40) });
      assert.equal(factor(result, "Deadline approaching"), undefined);
      assert.equal(factor(result, "Deadline pressure"), undefined);
      assert.equal(result.score, 82);
    });
  });

  describe("a target date met by a submitted proposal", () => {
    // The change the RFP lifecycle work makes. Every test above still passes
    // untouched, because none of them supplies this signal: the behaviour is
    // added for projects that have a submitted RFP behind their date, and
    // nothing else moves.
    const met = { submittedAt: daysAway(-11), decisionExpectedAt: daysAway(20) };

    test("the passed deadline stops costing 30, and the project stays on track", () => {
      const before = scoreProjectHealth({ ...base, targetDate: daysAway(-10) });
      const after = scoreProjectHealth({ ...base, targetDate: daysAway(-10), targetMetBySubmission: met });

      assert.equal(before.value, "at_risk", "the baseline changed; re-read the characterisation suite");
      assert.equal(after.value, "on_track");
      assert.equal(after.score, 82, "meeting the deadline should leave the score where it started");
      assert.equal(factor(after, "Past deadline"), undefined, "a met deadline was still counted as missed");
    });

    test("it says so, at no weight, so the health panel explains itself", () => {
      const result = scoreProjectHealth({ ...base, targetDate: daysAway(-10), targetMetBySubmission: met });
      const submitted = factor(result, "Proposal submitted");
      assert.equal(submitted?.impact, 0);
      assert.match(submitted?.detail ?? "", /^Submitted \w+ \d+\. Decision expected \w+ \d+\.$/);
    });

    test("with no decision date, it says it is waiting", () => {
      const result = scoreProjectHealth({
        ...base, targetDate: daysAway(-10), targetMetBySubmission: { submittedAt: daysAway(-11) },
      });
      assert.equal(factor(result, "Proposal submitted")?.detail, `Submitted ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(daysAway(-11))}. Awaiting decision.`);
    });

    test("an imported RFP with no submission date still counts, and says so without one", () => {
      const result = scoreProjectHealth({
        ...base, targetDate: daysAway(-10), targetMetBySubmission: { submittedAt: null, decisionExpectedAt: null },
      });
      assert.equal(result.value, "on_track");
      assert.equal(factor(result, "Proposal submitted")?.detail, "Submitted. Awaiting decision.");
    });

    test("deadline pressure also stands down — there is nothing left to race", () => {
      const result = scoreProjectHealth({
        ...base, targetDate: daysAway(7), openTasks: 6, targetMetBySubmission: met,
      });
      assert.equal(factor(result, "Deadline pressure"), undefined);
      assert.equal(result.score, 82);
    });

    test("real slippage is still scored: overdue tasks and silence still count", () => {
      // The point is to stop punishing a met deadline, not to stop looking.
      const result = scoreProjectHealth({
        ...base,
        targetDate: daysAway(-10),
        targetMetBySubmission: met,
        overdueTasks: 3,
        openTasks: 5,
        lastActivityAt: null,
      });
      assert.equal(factor(result, "Overdue tasks")?.impact, -24);
      assert.equal(factor(result, "No recent activity")?.impact, -25);
      assert.equal(result.score, 21);
      assert.equal(result.value, "off_track");
    });
  });

  describe("bands and presentation", () => {
    test("65 and above is on track, 40 and above is at risk, below is off track", () => {
      assert.equal(scoreProjectHealth({ ...base, overdueTasks: 2, openTasks: 4 }).value, "on_track"); // 66
      assert.equal(scoreProjectHealth({ ...base, targetDate: daysAway(-10) }).value, "at_risk"); // 52
      const bad = scoreProjectHealth({
        ...base,
        lastActivityAt: null,
        overdueTasks: 9,
        openTasks: 9,
        targetDate: daysAway(-10),
        hasNextAction: false,
      });
      assert.equal(bad.value, "off_track");
      assert.equal(bad.summary, "Off track. This needs a deliberate reset.");
    });

    test("the score never leaves 0-100", () => {
      const floor = scoreProjectHealth({
        ...base,
        lastActivityAt: null,
        overdueTasks: 20,
        openTasks: 20,
        totalMilestones: 5,
        overdueMilestones: 5,
        targetDate: daysAway(-30),
        hasNextAction: false,
        budgetCents: 10,
        revenueCents: 1_000,
      });
      assert.equal(floor.score, 0);
    });

    test("factors are ordered by how much they moved the score", () => {
      const result = scoreProjectHealth({
        ...base, targetDate: daysAway(-10), overdueTasks: 1, openTasks: 3, hasNextAction: false,
      });
      const impacts = result.factors.map((f) => Math.abs(f.impact));
      assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a), "factors are not sorted by weight");
      assert.equal(result.factors[0]?.label, "Past deadline");
    });
  });
});
