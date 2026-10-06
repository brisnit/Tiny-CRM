import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LEGAL_EFFECTIVE_ON, TERMS_VERSION, legalEffectiveDate } from "../../src/lib/legal";

/**
 * The published version must be a decision, not a side effect of the build.
 *
 * If `LEGAL_EFFECTIVE_ON` were ever derived from the clock, every build would
 * re-date documents nobody edited, and acceptances already recorded would name a
 * version string no page had displayed. These tests pin it as a literal, and pin
 * it to the version a signup records.
 */
describe("the published legal version", () => {
  test("is a literal ISO date, not computed from the clock", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../src/lib/legal.ts"), "utf8");
    const declaration = source.match(/export const LEGAL_EFFECTIVE_ON\s*=\s*([^;]+);/)?.[1]?.trim();
    assert.ok(declaration, "LEGAL_EFFECTIVE_ON is not declared as a simple export const");
    assert.match(
      declaration!,
      /^"\d{4}-\d{2}-\d{2}"$/,
      `LEGAL_EFFECTIVE_ON must be a literal date string, found: ${declaration}`,
    );
    // Belt and braces: no clock call anywhere near the declaration.
    const near = source.slice(Math.max(0, source.indexOf("export const LEGAL_EFFECTIVE_ON") - 200));
    const upToDecl = near.slice(0, near.indexOf(";") + 1);
    for (const forbidden of ["Date.now", "new Date()", "toISOString"]) {
      assert.ok(
        !upToDecl.includes(forbidden),
        `the version looks derived from the clock (${forbidden})`,
      );
    }
  });

  test("is the same string a signup records", () => {
    assert.equal(
      TERMS_VERSION,
      LEGAL_EFFECTIVE_ON,
      "the recorded version and the published effective date have drifted apart",
    );
  });

  test("renders as the same day it names", () => {
    const day = Number(LEGAL_EFFECTIVE_ON.split("-")[2]);
    assert.ok(
      legalEffectiveDate().startsWith(String(day)),
      `${legalEffectiveDate()} does not start with day ${day} — a timezone off-by-one`,
    );
  });
});
