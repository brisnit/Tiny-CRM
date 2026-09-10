import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  coerceBoolean, coerceDate, coerceEnum, coerceInt, coerceMoneyCents, coerceText,
  isBlank, neutralizeCell,
} from "../../src/lib/import/coerce";

/**
 * Every value in these tests is one that actually appears in the RFP tracker
 * this was written against. The point of the suite is the refusals: the cases
 * where the honest answer is "I don't know" and the damage comes from
 * answering anyway.
 */

describe("reading a spreadsheet cell", () => {
  describe("dates", () => {
    test("ISO dates are read", () => {
      const result = coerceDate("2026-09-15");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value?.toISOString().slice(0, 10), "2026-09-15");
    });

    test("the several ways of writing 'no deadline' are blank, not errors", () => {
      for (const raw of ["", "NA", "n/a", "—", "TBD", "unknown"]) {
        const result = coerceDate(raw);
        assert.equal(result.ok, true, `${raw} was treated as an error`);
        if (result.ok) assert.equal(result.value, null, `${raw} produced a date`);
      }
    });

    test("an ambiguous slash date is refused rather than assumed", () => {
      // 03/04/2026 is March in the US and April almost everywhere else. Guessing
      // puts a deadline a month wrong, and nothing downstream can detect it.
      const result = coerceDate("03/04/2026");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /ambiguous/i);
    });

    test("a date-shaped value that is not a real date is refused", () => {
      const result = coerceDate("2026-13-45");
      assert.equal(result.ok, false);
    });
  });

  describe("money", () => {
    test("a plain amount is read into cents", () => {
      const result = coerceMoneyCents("$239,000");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, 23_900_000);
    });

    test("a range is refused rather than flattened to one end", () => {
      // "$30,000-$40,000" has no single right answer. Taking the low end
      // understates the pipeline; taking the high end overstates it.
      const result = coerceMoneyCents("$30,000-$40,000");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /range/i);
    });

    test("prose in a money column is refused, not read as zero", () => {
      for (const raw of ["Millions", "unknown", "ask"]) {
        const result = coerceMoneyCents(raw);
        if (raw === "unknown") {
          assert.equal(result.ok, true, "a documented blank should not be an error");
          if (result.ok) assert.equal(result.value, null);
        } else {
          assert.equal(result.ok, false, `${raw} was silently coerced`);
        }
      }
    });

    test("a value too large for a safe integer is refused", () => {
      const result = coerceMoneyCents("999999999999999999999");
      assert.equal(result.ok, false);
    });
  });

  describe("booleans", () => {
    test("both vocabularies in one workbook are read", () => {
      // The tracker uses Yes/No in two columns and TRUE/FALSE in four others.
      for (const raw of ["Yes", "TRUE", "y", "1", "x"]) {
        const result = coerceBoolean(raw);
        assert.equal(result.ok, true, `${raw} not read`);
        if (result.ok) assert.equal(result.value, true, `${raw} read as false`);
      }
      for (const raw of ["No", "FALSE", "n", "0"]) {
        const result = coerceBoolean(raw);
        assert.equal(result.ok, true, `${raw} not read`);
        if (result.ok) assert.equal(result.value, false, `${raw} read as true`);
      }
    });

    test("a person hedging is not a boolean", () => {
      const result = coerceBoolean("not yet");
      assert.equal(result.ok, false);
    });
  });

  describe("fixed sets", () => {
    const options = ["not_started", "drafting", "submitted", "won", "lost"] as const;

    test("case and punctuation do not matter", () => {
      const result = coerceEnum("SUBMITTED", options);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, "submitted");
    });

    test("a declared alias is honoured and explained", () => {
      const result = coerceEnum("BID SUBMITTED", options, { "BID SUBMITTED": "submitted" });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value, "submitted");
        assert.match(result.note ?? "", /Read "BID SUBMITTED" as submitted/);
      }
    });

    test("an unrecognised value is refused rather than snapped to the nearest", () => {
      // "Sent Clarifying Questions" is a real status from the tracker. It is
      // not "drafting" and guessing that it is would move a live bid.
      const result = coerceEnum("Sent Clarifying Questions", options);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /not_started/);
    });
  });

  describe("formula injection", () => {
    test("a formula is made inert on the way in", () => {
      // Export already neutralises. Import did not, so the value was stored
      // live and became a formula for whoever opened a later export.
      const cell = neutralizeCell('=HYPERLINK("http://attacker","Click")');
      assert.ok(!cell.startsWith("="), `still a formula: ${cell}`);
    });

    test("every dangerous lead character is covered", () => {
      for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
        const cell = neutralizeCell(`${lead}cmd|' /C calc'!A0`);
        assert.ok(!cell.startsWith(lead), `${JSON.stringify(lead)} survived`);
      }
    });

    test("escaping does not accumulate across round trips", () => {
      const once = neutralizeCell("=1+1");
      const twice = neutralizeCell(once);
      assert.equal(once, twice, "a second pass added another escape");
    });

    test("ordinary text is left alone", () => {
      assert.equal(neutralizeCell("Website Redesign"), "Website Redesign");
    });

    test("text coercion neutralises too", () => {
      const result = coerceText("=SUM(A1:A9)", 200);
      assert.equal(result.ok, true);
      if (result.ok) assert.ok(!result.value!.startsWith("="));
    });
  });

  describe("numbers and text", () => {
    test("a score is read, and one out of range is refused", () => {
      const good = coerceInt("72", 0, 100);
      assert.equal(good.ok, true);
      if (good.ok) assert.equal(good.value, 72);

      const bad = coerceInt("140", 0, 100);
      assert.equal(bad.ok, false);
    });

    test("an em dash in a score column is blank, not an error", () => {
      const result = coerceInt("—", 0, 100);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, null);
    });

    test("over-long text is trimmed and the trimming is reported", () => {
      const result = coerceText("x".repeat(300), 200);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value?.length, 200);
        assert.match(result.note ?? "", /Trimmed from 300/);
      }
    });

    test("blank detection covers what people actually type", () => {
      for (const raw of ["", " ", "-", "—", "N/A", "none", "TBD"]) {
        assert.equal(isBlank(raw), true, `${JSON.stringify(raw)} not treated as blank`);
      }
      assert.equal(isBlank("0"), false, "zero is a value");
      assert.equal(isBlank("Millions"), false);
    });
  });
});
