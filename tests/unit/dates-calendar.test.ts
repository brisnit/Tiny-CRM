import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  dateOnlyInputValue, daysFromNowDateOnly, formatDate, formatDateOnly,
  formatDateTime, formatDayOnly, todayDateOnlyInputValue,
} from "../../src/lib/dates";

/**
 * A deadline is a day, not an instant.
 *
 * The reported bug: an RFP due 2026-09-29 displayed as Sep 28 in Pacific time.
 * The worse bug underneath it: the edit form pre-filled that shifted day, so
 * opening a record and saving it walked the date backwards — twice, and it had
 * moved two days.
 *
 * Node re-reads `process.env.TZ` on the next Date operation, so each case sets
 * the zone directly. The first version of this spawned `npx tsx` fifteen times
 * per run to get a fresh process per timezone. It passed locally and was the
 * only new thing in the commit that failed PostgreSQL 18 in CI while every
 * other job passed — which is what a slow, spawn-heavy test looks like from
 * the outside. Whether or not that was the cause, a test that shells out
 * fifteen times to assert on a pure function is the wrong shape.
 *
 * Five zones, deliberately spanning both sides of UTC: the bug was invisible
 * in London and Tokyo, which is exactly how it survived.
 */

const ZONES = ["America/Los_Angeles", "America/New_York", "UTC", "Europe/London", "Asia/Tokyo"];
const ORIGINAL_TZ = process.env.TZ;

/** Runs `fn` as if the reader were in `tz`, and puts the clock back after. */
function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
}

describe("calendar dates are the same day everywhere", () => {
  test("the exact reported regression: 2026-09-29 shows as Sep 29 in Pacific", () => {
    const shown = inZone("America/Los_Angeles", () => formatDateOnly(new Date("2026-09-29")));
    assert.equal(shown, "Sep 29, 2026", "the deadline still displays a day early in Pacific");
  });

  test("every timezone renders the same calendar day", () => {
    for (const tz of ZONES) {
      const shown = inZone(tz, () => formatDateOnly(new Date("2026-09-29")));
      assert.equal(shown, "Sep 29, 2026", `${tz} rendered ${shown}`);
    }
  });

  test("an edit form pre-fills the day that was stored", () => {
    for (const tz of ZONES) {
      const prefill = inZone(tz, () => dateOnlyInputValue(new Date("2026-09-29")));
      assert.equal(prefill, "2026-09-29", `${tz} pre-filled ${prefill}`);
    }
  });

  test("saving a record without touching the date does not move it", () => {
    // The corruption case. Round-tripping through the form three times used to
    // walk the date back three days in Pacific.
    for (const tz of ZONES) {
      const landed = inZone(tz, () => {
        let d = new Date("2026-09-29");
        for (let i = 0; i < 3; i++) d = new Date(dateOnlyInputValue(d));
        return d.toISOString().slice(0, 10);
      });
      assert.equal(landed, "2026-09-29", `${tz} walked the date to ${landed}`);
    }
  });

  test("the year boundary does not shift either", () => {
    for (const tz of ZONES) {
      const shown = inZone(tz, () => formatDateOnly(new Date("2027-01-01")));
      assert.equal(shown, "Jan 1, 2027", `${tz} rendered ${shown}`);
    }
  });

  test("days remaining is counted from the viewer's own day", () => {
    for (const tz of ZONES) {
      const days = inZone(tz, () => {
        const now = new Date();
        const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 5));
        return daysFromNowDateOnly(target, now);
      });
      assert.equal(days, 5, `${tz} counted ${days} days`);
    }
  });

  test("today is today, not yesterday", () => {
    for (const tz of ZONES) {
      const shown = inZone(tz, () => {
        const now = new Date();
        const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        return formatDayOnly(today);
      });
      assert.equal(shown, "Today", `${tz} called today ${shown}`);
    }
  });
});

describe("real timestamps keep their timezone meaning", () => {
  test("an instant renders in the viewer's local time, as it should", () => {
    // 2026-09-29T02:00:00Z is the 28th at 7pm in Los Angeles and the 29th at
    // 11am in Tokyo. That is correct for a timestamp and must not be "fixed".
    const instant = new Date("2026-09-29T02:00:00Z");
    const la = inZone("America/Los_Angeles", () => formatDateTime(instant));
    const tokyo = inZone("Asia/Tokyo", () => formatDateTime(instant));

    assert.match(la, /Sep 28, 2026 · 7:00 PM/, `Los Angeles showed ${la}`);
    assert.match(tokyo, /Sep 29, 2026 · 11:00 AM/, `Tokyo showed ${tokyo}`);
    assert.notEqual(la, tokyo, "a timestamp was flattened to a calendar date");
  });

  test("the local formatters are still local", () => {
    // Guards against someone "fixing" the timestamp path by switching it to UTC.
    const la = inZone("America/Los_Angeles", () => formatDate(new Date("2026-09-29T02:00:00Z")));
    assert.equal(la, "Sep 28, 2026", "formatDate stopped being local-time");
  });
});

describe("\"today\" is the viewer's day, not UTC's", () => {
  /**
   * The evening problem. At 21:07 in California it is already tomorrow in UTC,
   * so a default read off the UTC day offers a date the person has not lived
   * through yet. "Mark submitted" promised today and pre-filled tomorrow, which
   * is how a proposal could be recorded as going in on a day it did not.
   *
   * Found by a browser test failing in the evening and passing in CI, which
   * runs in UTC — where the bug cannot appear at all.
   */
  const EVENING_IN_CALIFORNIA = new Date("2026-09-17T04:07:00Z");

  test("an evening in Pacific still says today, not tomorrow", () => {
    const value = inZone("America/Los_Angeles", () => todayDateOnlyInputValue(EVENING_IN_CALIFORNIA));
    assert.equal(value, "2026-09-16", "the default jumped to the UTC day");
  });

  test("the old rule is what got this wrong", () => {
    // Kept as the contrast: dateOnlyInputValue reads the UTC day off an
    // instant, which is correct for a stored date-only value and wrong for
    // "now". This asserts the difference rather than describing it.
    const old = inZone("America/Los_Angeles", () => dateOnlyInputValue(EVENING_IN_CALIFORNIA));
    assert.equal(old, "2026-09-17", "the UTC reading is no longer what it was");
    assert.notEqual(
      inZone("America/Los_Angeles", () => todayDateOnlyInputValue(EVENING_IN_CALIFORNIA)),
      old,
      "the today helper is still reading the UTC day",
    );
  });

  // The date the field offers must be the one the rest of the app calls
  // "Today" — the two disagreeing is the whole defect. daysFromNowDateOnly is
  // the comparison that takes the instant, so both sides read the same clock.
  const isToday = (tz: string, value: string, now: Date) =>
    inZone(tz, () => daysFromNowDateOnly(new Date(`${value}T00:00:00Z`), now));

  test("every zone gets its own day, and the app agrees it is today", () => {
    for (const tz of ZONES) {
      const value = inZone(tz, () => todayDateOnlyInputValue(EVENING_IN_CALIFORNIA));
      const days = isToday(tz, value, EVENING_IN_CALIFORNIA);
      assert.equal(days, 0, `${tz} pre-filled ${value}, which is ${days} day(s) from its own today`);
    }
  });

  test("a midday instant is unremarkable in every zone", () => {
    const midday = new Date("2026-09-17T12:00:00Z");
    for (const tz of ZONES) {
      const value = inZone(tz, () => todayDateOnlyInputValue(midday));
      const days = isToday(tz, value, midday);
      assert.equal(days, 0, `${tz} pre-filled ${value}, which is ${days} day(s) from its own today`);
    }
  });
});
