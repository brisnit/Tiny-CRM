import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * A deadline is a day, not an instant.
 *
 * The reported bug: an RFP due 2026-09-29 displayed as Sep 28 in Pacific time.
 * The worse bug underneath it: the edit form pre-filled that shifted day, so
 * opening a record and saving it walked the date backwards — twice, and it had
 * moved two days.
 *
 * Timezone cannot be changed inside a running process (`process.env.TZ` is read
 * once when the date code initialises), so each case runs in its own process
 * with TZ set. Five zones, deliberately spanning both sides of UTC: the bug was
 * invisible in London and Tokyo, which is exactly how it survived.
 */

const ZONES = ["America/Los_Angeles", "America/New_York", "UTC", "Europe/London", "Asia/Tokyo"];
const ROOT = resolve(import.meta.dirname, "../..");

function inZone(tz: string, body: string): string {
  return execFileSync("npx", ["tsx", "--eval", body], {
    cwd: ROOT,
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  }).trim();
}

describe("calendar dates are the same day everywhere", () => {
  test("the exact reported regression: 2026-09-29 shows as Sep 29 in Pacific", () => {
    const output = inZone(
      "America/Los_Angeles",
      `import { formatDateOnly } from "./src/lib/dates";
       process.stdout.write(formatDateOnly(new Date("2026-09-29")));`,
    );
    assert.equal(output, "Sep 29, 2026", "the deadline still displays a day early in Pacific");
  });

  test("every timezone renders the same calendar day", () => {
    for (const tz of ZONES) {
      const output = inZone(
        tz,
        `import { formatDateOnly } from "./src/lib/dates";
         process.stdout.write(formatDateOnly(new Date("2026-09-29")));`,
      );
      assert.equal(output, "Sep 29, 2026", `${tz} rendered ${output}`);
    }
  });

  test("an edit form pre-fills the day that was stored", () => {
    for (const tz of ZONES) {
      const output = inZone(
        tz,
        `import { dateOnlyInputValue } from "./src/lib/dates";
         process.stdout.write(dateOnlyInputValue(new Date("2026-09-29")));`,
      );
      assert.equal(output, "2026-09-29", `${tz} pre-filled ${output}`);
    }
  });

  test("saving a record without touching the date does not move it", () => {
    // The corruption case. Round-tripping through the form three times used to
    // walk the date back three days in Pacific.
    for (const tz of ZONES) {
      const output = inZone(
        tz,
        `import { dateOnlyInputValue } from "./src/lib/dates";
         let d = new Date("2026-09-29");
         for (let i = 0; i < 3; i++) d = new Date(dateOnlyInputValue(d));
         process.stdout.write(d.toISOString().slice(0, 10));`,
      );
      assert.equal(output, "2026-09-29", `${tz} walked the date to ${output}`);
    }
  });

  test("the year boundary does not shift either", () => {
    for (const tz of ZONES) {
      const output = inZone(
        tz,
        `import { formatDateOnly } from "./src/lib/dates";
         process.stdout.write(formatDateOnly(new Date("2027-01-01")));`,
      );
      assert.equal(output, "Jan 1, 2027", `${tz} rendered ${output}`);
    }
  });

  test("days remaining is counted from the viewer's own day", () => {
    // Both sides of UTC, same answer, for a date five days out.
    for (const tz of ZONES) {
      const output = inZone(
        tz,
        `import { daysFromNowDateOnly } from "./src/lib/dates";
         const now = new Date();
         const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 5));
         process.stdout.write(String(daysFromNowDateOnly(target, now)));`,
      );
      assert.equal(output, "5", `${tz} counted ${output} days`);
    }
  });

  test("today is today, not yesterday", () => {
    for (const tz of ZONES) {
      const output = inZone(
        tz,
        `import { formatDayOnly } from "./src/lib/dates";
         const now = new Date();
         const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
         process.stdout.write(formatDayOnly(today));`,
      );
      assert.equal(output, "Today", `${tz} called today ${output}`);
    }
  });
});

describe("real timestamps keep their timezone meaning", () => {
  test("an instant renders in the viewer's local time, as it should", () => {
    // 2026-09-29T02:00:00Z is the 28th at 7pm in Los Angeles and the 29th at
    // 11am in Tokyo. That is correct for a timestamp and must not be "fixed".
    const la = inZone(
      "America/Los_Angeles",
      `import { formatDateTime } from "./src/lib/dates";
       process.stdout.write(formatDateTime(new Date("2026-09-29T02:00:00Z")));`,
    );
    const tokyo = inZone(
      "Asia/Tokyo",
      `import { formatDateTime } from "./src/lib/dates";
       process.stdout.write(formatDateTime(new Date("2026-09-29T02:00:00Z")));`,
    );
    assert.match(la, /Sep 28, 2026 · 7:00 PM/, `Los Angeles showed ${la}`);
    assert.match(tokyo, /Sep 29, 2026 · 11:00 AM/, `Tokyo showed ${tokyo}`);
    assert.notEqual(la, tokyo, "a timestamp was flattened to a calendar date");
  });

  test("the local formatters are still local", () => {
    // Guards against someone "fixing" the timestamp path by switching it to UTC.
    const la = inZone(
      "America/Los_Angeles",
      `import { formatDate } from "./src/lib/dates";
       process.stdout.write(formatDate(new Date("2026-09-29T02:00:00Z")));`,
    );
    assert.equal(la, "Sep 28, 2026", "formatDate stopped being local-time");
  });
});
