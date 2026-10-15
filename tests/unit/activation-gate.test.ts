import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  activationPermitted, noticeWindow, INTEGRATIONS_EFFECTIVE_ON,
} from "../../src/lib/legal/notice-window";

/**
 * Activation needs two independent things, and the dangerous one is the
 * second.
 *
 * Notice sent on 15 October closes its 30-day window on 14 November. The
 * page tells customers the sections take effect on 16 November. On the 14th
 * every delivery check passes and the notice commitment is met — and
 * activating would still contradict the published text, turning the feature
 * on two days before the document says it exists.
 *
 * "The checks are green" is precisely the argument that gets made on the
 * 14th, so the gate is written to answer it.
 */
const SENT = new Date(Date.UTC(2026, 9, 15, 17, 0, 0));      // 15 October
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

const windowAt = (at: Date) => noticeWindow([SENT], { at });

describe("activation requires the date AND the notice checks", () => {
  test("14 November: every notice check passes and activation is REFUSED", () => {
    // 20:00 UTC, deliberately. The send was at 17:00 on 15 October, so the
    // 30 days close at 17:00 on 14 November — not at midnight. Checking at
    // noon would have tested a window that had not yet elapsed, which is a
    // weaker case than the one that matters and would have passed for the
    // wrong reason.
    const at = new Date(Date.UTC(2026, 10, 14, 20, 0, 0));
    const w = windowAt(at);
    assert.equal(w.elapsed, true, "the 30 days really have elapsed by the 14th");
    assert.equal(w.blocked, null);

    const v = activationPermitted(w, { at });
    assert.equal(v.permitted, false, "activation was permitted two days early");
    assert.equal(v.noticeElapsed, true);
    assert.equal(v.dateReached, false);
    assert.equal(v.blockers.length, 1);
    assert.match(v.blockers[0]!, /published effective date/);
  });

  test("15 November, the day before: still refused", () => {
    const at = day(2026, 11, 15);
    const v = activationPermitted(windowAt(at), { at });
    assert.equal(v.permitted, false);
    assert.equal(v.dateReached, false);
  });

  test("16 November at midnight UTC: permitted", () => {
    const at = new Date(Date.UTC(2026, 10, 16, 0, 0, 0));
    const v = activationPermitted(windowAt(at), { at });
    assert.equal(v.dateReached, true);
    assert.equal(v.permitted, true, `blocked by: ${v.blockers.join("; ")}`);
  });

  test("a machine behind UTC does not open the gate a day early", () => {
    /**
     * 15 November, 20:00 in Los Angeles is 16 November 04:00 UTC — the gate
     * is open, correctly, because the instant really is the 16th in UTC.
     * The failure guarded here is the reverse: parsing the published date
     * itself in local time, which would make midnight local on the 16th in
     * LA (08:00 UTC) the boundary and open the gate during the 15th for
     * anyone east of it. The date is parsed as UTC explicitly.
     */
    const justBefore = new Date(Date.UTC(2026, 10, 15, 23, 59, 59));
    assert.equal(activationPermitted(windowAt(justBefore), { at: justBefore }).dateReached, false);
    const justAfter = new Date(Date.UTC(2026, 10, 16, 0, 0, 1));
    assert.equal(activationPermitted(windowAt(justAfter), { at: justAfter }).dateReached, true);
  });

  test("the date alone is not enough either", () => {
    // Nobody notified, long past the effective date.
    const at = day(2027, 1, 1);
    const v = activationPermitted(noticeWindow([], { at }), { at });
    assert.equal(v.permitted, false, "activation was permitted with nobody notified");
    assert.equal(v.dateReached, true);
    assert.match(v.blockers.join(" "), /nobody has been given notice/);
  });

  test("an unreadable acceptance blocks even after the date", () => {
    const at = day(2027, 1, 1);
    const v = activationPermitted(noticeWindow([SENT, new Date("nonsense")], { at }), { at });
    assert.equal(v.permitted, false);
    assert.match(v.blockers.join(" "), /could not be read/);
  });

  test("both unmet are both reported, not just the first", () => {
    const at = day(2026, 11, 1);
    const v = activationPermitted(noticeWindow([day(2026, 10, 30)], { at }), { at });
    assert.equal(v.blockers.length, 2, `got: ${v.blockers.join(" | ")}`);
  });

  test("the gate's date is the one the page publishes", () => {
    assert.equal(INTEGRATIONS_EFFECTIVE_ON, "2026-11-16");
  });
});
