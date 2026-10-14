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

  test("invalid timestamps are discarded rather than poisoning the maximum", () => {
    // An unparseable date arriving as NaN would otherwise make every
    // comparison false and the window silently permissive.
    const w = noticeWindow([day(1), new Date("not a date"), day(11)], { at: day(11 + NOTICE_DAYS) });
    assert.equal(w.count, 2);
    assert.equal(w.latest?.toISOString(), day(11).toISOString());
    assert.equal(w.elapsed, true);
  });
});
