import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessOpportunity } from "../../src/lib/data/opportunities";

/**
 * An unjudged opportunity gets no verdict.
 *
 * The scorer needs a human input — fit, strategic value, competition — before
 * it can say anything about whether to bid. With none of those it is working
 * from the deadline and the contact count, and for a freshly imported backlog
 * that is every row: nobody has been contacted yet and the clock is already
 * running, so it floors all of them.
 *
 * Measured against the real tracker this was built for, an 82/100 GO closing
 * in four days came out "no bid". Presenting that is worse than saying nothing
 * — it argues against work the person has already decided to pursue.
 */

const base = {
  fitScore: null as number | null,
  strategicValue: null as string | null,
  competitionLevel: null as string | null,
  estimatedValueCents: null as number | null,
  deadlineAt: null as Date | null,
  submissionStatus: "not_started",
  requirements: null as string | null,
  contactCount: 0,
};

describe("Tiny only offers a verdict once somebody has judged the work", () => {
  test("no fit, no strategic value, no competition: not assessed", () => {
    const a = assessOpportunity({ ...base });
    assert.equal(a.assessed, false, "an unjudged opportunity claimed to be assessed");
  });

  test("the imported-backlog shape is not assessed", () => {
    // Exactly what an imported row looks like: a real deadline, no contacts,
    // and none of the three judgement fields set.
    const a = assessOpportunity({
      ...base,
      deadlineAt: new Date(Date.now() + 4 * 86_400_000),
      contactCount: 0,
    });
    assert.equal(a.assessed, false);
    // It still computes a number — the UI is what withholds it — and that
    // number is exactly why it must not be shown.
    assert.ok(a.score < 55, `the floor effect has gone, score was ${a.score}`);
  });

  test("any one of the three judgement fields is enough", () => {
    for (const judged of [
      { ...base, fitScore: 80 },
      { ...base, strategicValue: "high" },
      { ...base, competitionLevel: "low" },
    ]) {
      const a = assessOpportunity(judged);
      assert.equal(a.assessed, true, `a judged opportunity was treated as unassessed: ${JSON.stringify(judged)}`);
    }
  });

  test("a fit score of zero still counts as judged", () => {
    // Somebody deciding this is a poor fit is a judgement, not an absence.
    const a = assessOpportunity({ ...base, fitScore: 0 });
    assert.equal(a.assessed, true, "an explicit zero was mistaken for no answer");
  });

  test("deadline pressure and contacts alone never make it assessed", () => {
    const a = assessOpportunity({
      ...base,
      deadlineAt: new Date(Date.now() - 86_400_000),
      contactCount: 9,
      estimatedValueCents: 50_000_00,
    });
    assert.equal(a.assessed, false, "circumstances were mistaken for a judgement");
  });

  test("the arithmetic is unchanged for a judged opportunity", () => {
    // The flag is presentational. A scored opportunity must score the same as
    // it did before this existed: 50 + (80-50)/2 + high(15) + low(12) - 10 for
    // no contacts = 82.
    const a = assessOpportunity({
      ...base, fitScore: 80, strategicValue: "high", competitionLevel: "low",
    });
    assert.equal(a.score, 82, `scoring changed: ${a.score}`);
    assert.equal(a.recommendation, "go");
  });
});
