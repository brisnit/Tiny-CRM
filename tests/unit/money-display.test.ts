import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { formatMoney, formatMoneyOrDash } from "../../src/lib/money";

/**
 * An amount nobody recorded is not an amount of zero.
 *
 * `formatMoney` folds null to 0 deliberately — it shares `fromCents` with the
 * arithmetic, where a missing figure contributes nothing to a total. Every
 * display reached for the same helper, so an opportunity that had never been
 * priced read "$0", which is a claim the record never made.
 *
 * Importing a real pipeline is what made it undeniable: twenty-three of
 * twenty-four rows carried no figure, and the list told the owner each one was
 * worth nothing.
 */

const ROOT = resolve(import.meta.dirname, "../..");

describe("an unrecorded amount does not read as zero", () => {
  test("a null value is a dash, not $0", () => {
    assert.equal(formatMoneyOrDash(null), "—");
    assert.equal(formatMoneyOrDash(undefined), "—");
  });

  test("an amount that really is zero still reads as zero", () => {
    // A deal priced at nothing is a fact about the deal. Only absence is a dash.
    assert.equal(formatMoneyOrDash(0), "$0");
  });

  test("a real amount is formatted exactly as before", () => {
    for (const cents of [1, 99, 100, 123_456, 23_900_000]) {
      assert.equal(formatMoneyOrDash(cents), formatMoney(cents), `${cents} cents`);
    }
  });

  test("the caller can say what absence looks like", () => {
    // Inside a sentence a bare dash reads as a typo.
    assert.equal(formatMoneyOrDash(null, "value not set"), "value not set");
  });

  test("the surfaces that show one opportunity's value no longer fold null to zero", () => {
    // Behavioural where it can be, structural here: these are server
    // components, and the defect was one identifier in each of them.
    for (const file of [
      "src/app/(app)/opportunities/page.tsx",
      "src/app/(app)/opportunities/[id]/page.tsx",
      "src/app/(app)/companies/[id]/page.tsx",
    ]) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      assert.match(source, /formatMoneyOrDash\(/, `${file} still prints $0 for an unpriced record`);
      assert.ok(
        !/[^a-zA-Z]formatMoney\(opp(ortunity)?\.estimatedValueCents\)/.test(source),
        `${file} still formats an estimated value through formatMoney`,
      );
    }
  });

  test("totals keep folding null to zero", () => {
    // The other half of the contract: an empty pipeline totals $0, not a dash.
    assert.equal(formatMoney(null), "$0");
  });
});
