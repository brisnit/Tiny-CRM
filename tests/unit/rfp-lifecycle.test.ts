import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isSubmitted, meetsProjectTarget, submissionTiming } from "../../src/lib/rfp-lifecycle";

/**
 * When a deadline stops being an obligation.
 *
 * The rule these tests pin is deliberately narrow, because the failure modes
 * point in opposite directions: too loose and a project with any submitted RFP
 * attached goes quiet about dates it really is missing; too strict and a bid
 * that went in on time keeps being called overdue, which is the bug this work
 * exists to fix.
 */

/** A date-only value N days from today, at local noon so no comparison lands on a boundary. */
function day(offset: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(12, 0, 0, 0);
  return date;
}

describe("has it been submitted?", () => {
  test("a submission date is the plainest evidence", () => {
    assert.equal(isSubmitted({ submissionStatus: "submitted", submittedAt: day(-2) }), true);
  });

  test("every post-submission state counts, date or not", () => {
    for (const status of ["submitted", "under_review", "shortlisted"]) {
      assert.equal(isSubmitted({ submissionStatus: status, submittedAt: null }), true, status);
    }
  });

  test("an award or a rejection implies the proposal went in", () => {
    assert.equal(isSubmitted({ submissionStatus: "won", submittedAt: null }), true);
    assert.equal(isSubmitted({ submissionStatus: "lost", submittedAt: null }), true);
  });

  test("withdrawing does not, unless a date says so", () => {
    // A pursuit can be abandoned before anything is sent, so the status alone
    // proves nothing either way.
    assert.equal(isSubmitted({ submissionStatus: "withdrawn", submittedAt: null }), false);
    assert.equal(isSubmitted({ submissionStatus: "withdrawn", submittedAt: day(-5) }), true);
  });

  test("deciding not to bid, or still preparing, is not submitted", () => {
    for (const status of ["no_bid", "not_started", "drafting", "internal_review"]) {
      assert.equal(isSubmitted({ submissionStatus: status, submittedAt: null }), false, status);
    }
  });
});

describe("early, on time, late — or no opinion", () => {
  test("before the deadline is early, and says by how much", () => {
    const timing = submissionTiming({
      submissionStatus: "submitted", submittedAt: day(-5), proposalDeadlineAt: day(-2),
    });
    assert.equal(timing?.verdict, "early");
    assert.equal(timing?.days, -3);
  });

  test("the same day is on time", () => {
    const timing = submissionTiming({
      submissionStatus: "submitted", submittedAt: day(-2), proposalDeadlineAt: day(-2),
    });
    assert.equal(timing?.verdict, "on_time");
    assert.equal(timing?.days, 0);
  });

  test("after the deadline is late — the one worth showing a person", () => {
    const timing = submissionTiming({
      submissionStatus: "submitted", submittedAt: day(-1), proposalDeadlineAt: day(-3),
    });
    assert.equal(timing?.verdict, "late");
    assert.equal(timing?.days, 2);
  });

  test("an imported row with no submission date gets no verdict, rather than a guessed one", () => {
    assert.equal(
      submissionTiming({ submissionStatus: "submitted", submittedAt: null, proposalDeadlineAt: day(-2) }),
      null,
    );
  });

  test("and neither does a submission with no deadline to judge it against", () => {
    assert.equal(
      submissionTiming({ submissionStatus: "submitted", submittedAt: day(-2), proposalDeadlineAt: null }),
      null,
    );
  });
});

describe("did a submitted proposal meet this project's target date?", () => {
  const submitted = {
    id: "opp1",
    submissionStatus: "submitted",
    submittedAt: day(-1),
    proposalDeadlineAt: day(-1),
    decisionExpectedAt: day(20),
    decidedAt: null,
  };

  test("same calendar day, and submitted: met", () => {
    const met = meetsProjectTarget(day(-1), [submitted]);
    assert.equal(met?.opportunityId, "opp1");
    assert.equal(met?.timing?.verdict, "on_time");
  });

  test("an imported row with no date still meets it — the status is the evidence", () => {
    // Exactly the shape of the imported backlog: submitted, date never captured.
    const met = meetsProjectTarget(day(-1), [
      { ...submitted, submittedAt: null, decisionExpectedAt: null },
    ]);
    assert.equal(met?.opportunityId, "opp1");
    assert.equal(met?.submittedAt, null, "a submission date was invented");
    assert.equal(met?.timing, null, "punctuality was judged without a date");
  });

  test("a different day does not count, however submitted it is", () => {
    // The project's date is its own; only sameness shows it is the RFP's.
    assert.equal(meetsProjectTarget(day(-1), [{ ...submitted, proposalDeadlineAt: day(-8) }]), null);
  });

  test("an unsubmitted RFP on the same day does not count", () => {
    assert.equal(
      meetsProjectTarget(day(-1), [{ ...submitted, submissionStatus: "drafting", submittedAt: null }]),
      null,
    );
  });

  test("a no-bid on the same day does not count either", () => {
    assert.equal(
      meetsProjectTarget(day(-1), [{ ...submitted, submissionStatus: "no_bid", submittedAt: null }]),
      null,
    );
  });

  test("among several linked RFPs, the one sharing the date decides", () => {
    const met = meetsProjectTarget(day(-1), [
      { ...submitted, id: "other", proposalDeadlineAt: day(-30) },
      { ...submitted, id: "match" },
    ]);
    assert.equal(met?.opportunityId, "match");
  });

  test("no target date, no opportunities, or no deadline on the RFP: nothing to meet", () => {
    assert.equal(meetsProjectTarget(null, [submitted]), null);
    assert.equal(meetsProjectTarget(day(-1), []), null);
    assert.equal(meetsProjectTarget(day(-1), [{ ...submitted, proposalDeadlineAt: null }]), null);
  });
});
