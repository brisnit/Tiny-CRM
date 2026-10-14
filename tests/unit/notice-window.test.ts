import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { noticeWindow, NOTICE_DAYS } from "../../src/lib/legal/notice-window";

/**
 * The notice window, and the staggered send that breaks the obvious rule.
 *
 * The commitment is to each person, not to the population, so it is met only
 * when whoever was notified LAST has had their 30 days. An earlier draft of
 * the activation rule measured from the earliest acceptance instead. With a
 * single-batch send the two agree, which is why that draft read fine; with a
 * staggered one they do not, and the person it shortchanges is the one who
 * was hardest to reach.
 */

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));

describe("the notice window is measured from the last person notified", () => {
  test("a staggered send is governed by the latest acceptance, not the earliest", () => {
    // A accepted on the 1st, B ten days later after a retry.
    const w = noticeWindow([day(1), day(11)], { at: day(1 + 31) });

    assert.equal(w.earliest?.toISOString(), day(1).toISOString());
    assert.equal(w.latest?.toISOString(), day(11).toISOString());

    // 31 days after the EARLIEST. The naive rule would activate here.
    assert.equal(
      w.elapsed,
      false,
      "activation was permitted while the last-notified person had had only 21 days",
    );
    assert.equal(w.daysRemaining, 9);
    assert.equal(w.activationFrom?.toISOString(), day(11 + NOTICE_DAYS).toISOString());
  });

  test("and it does elapse once the last person has had the full period", () => {
    const w = noticeWindow([day(1), day(11)], { at: day(11 + NOTICE_DAYS) });
    assert.equal(w.elapsed, true);
    assert.equal(w.daysRemaining, 0);
  });

  test("order of the input does not matter", () => {
    const forwards = noticeWindow([day(1), day(5), day(11)], { at: day(20) });
    const backwards = noticeWindow([day(11), day(1), day(5)], { at: day(20) });
    assert.deepEqual(forwards, backwards);
    assert.equal(forwards.latest?.toISOString(), day(11).toISOString());
  });

  test("one recipient is the degenerate case, not a special case", () => {
    const w = noticeWindow([day(1)], { at: day(1 + NOTICE_DAYS) });
    assert.equal(w.earliest?.toISOString(), w.latest?.toISOString());
    assert.equal(w.elapsed, true);
  });

  test("nobody notified is never elapsed, however long you wait", () => {
    // The failure this guards: an empty list averaging or maxing to "no
    // constraint" and reading as permission.
    const w = noticeWindow([], { at: day(28) });
    assert.equal(w.count, 0);
    assert.equal(w.elapsed, false, "activation was permitted with nobody notified");
    assert.equal(w.activationFrom, null);
    assert.equal(w.daysRemaining, Number.POSITIVE_INFINITY);
  });

  test("the boundary is inclusive: the exact instant counts as elapsed", () => {
    const at = day(1 + NOTICE_DAYS);
    assert.equal(noticeWindow([day(1)], { at }).elapsed, true);
    assert.equal(
      noticeWindow([day(1)], { at: new Date(at.getTime() - 1) }).elapsed,
      false,
      "a millisecond short of the period read as elapsed",
    );
  });

  test("a longer commitment is honoured if one is ever given", () => {
    const w = noticeWindow([day(1)], { at: day(35), noticeDays: 45 });
    assert.equal(w.elapsed, false);
    assert.equal(w.activationFrom?.toISOString(), day(1 + 45).toISOString());
  });

  test("one valid old timestamp plus one invalid REFUSES", () => {
    /**
     * The case asked for, and the one that shows why discarding is wrong.
     *
     * An earlier version filtered unreadable timestamps out and computed the
     * window from what remained. Here that would mean: the valid acceptance
     * is 60 days old, far past the period, so elapsed — while one recipient's
     * acceptance time is simply unknown. Discarding makes the answer MORE
     * permissive, which is the opposite of what an unreadable record should
     * do.
     *
     * If we cannot say when somebody was notified, we cannot say their 30
     * days have passed.
     */
    const w = noticeWindow([day(1), new Date("not a date")], { at: day(1 + 60) });

    assert.equal(w.elapsed, false, "an unreadable acceptance timestamp did not block the check");
    assert.equal(w.invalid, 1);
    assert.equal(w.count, 1, "the readable acceptance is still counted and reported");
    assert.equal(w.activationFrom, null, "a date was offered despite an unreadable record");
    assert.equal(w.daysRemaining, Number.POSITIVE_INFINITY);
    assert.match(w.blocked ?? "", /could not be read/);
  });

  test("an invalid timestamp blocks even when every other recipient is long past", () => {
    // Four acceptances a year old and one unreadable: still refused.
    const w = noticeWindow(
      [day(1), day(2), day(3), day(4), new Date(Number.NaN)],
      { at: new Date(Date.UTC(2027, 9, 1)) },
    );
    assert.equal(w.elapsed, false);
    assert.equal(w.invalid, 1);
    assert.equal(w.count, 4);
  });

  test("all timestamps valid and the ledger is not blocked", () => {
    const w = noticeWindow([day(1), day(11)], { at: day(11 + NOTICE_DAYS) });
    assert.equal(w.invalid, 0);
    assert.equal(w.blocked, null);
    assert.equal(w.elapsed, true);
  });

  test("an empty ledger is blocked, with the reason named", () => {
    const w = noticeWindow([], { at: day(28) });
    assert.equal(w.elapsed, false);
    assert.match(w.blocked ?? "", /nobody has been given notice/);
  });
});
