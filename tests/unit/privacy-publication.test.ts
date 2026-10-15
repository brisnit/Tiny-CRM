import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { INTEGRATIONS_EFFECTIVE_ON, LEGAL_EFFECTIVE_ON } from "../../src/lib/legal";

/**
 * The 15 October publication, pinned.
 *
 * The page carries two kinds of change at once and they must not be
 * presented the same way: integration sections that are published but NOT
 * yet in force, and a subprocessor correction that IS in force and always
 * was. Conflating them would either imply customers can connect a mailbox
 * today, or imply Sentry begins receiving error reports in November. Both
 * are false and only one of them is embarrassing.
 */
const PAGE = readFileSync("src/app/(marketing)/privacy/page.tsx", "utf8");

describe("the privacy notice as published on 15 October", () => {
  test("the notice in force is not re-dated by the pending change", () => {
    // Re-dating the whole document would move every recorded acceptance to a
    // version string no page ever displayed.
    assert.equal(LEGAL_EFFECTIVE_ON, "2026-10-05");
    assert.equal(INTEGRATIONS_EFFECTIVE_ON, "2026-11-16");
    assert.match(PAGE, /effectiveOn=\{legalEffectiveDate\(\)\}/);
  });

  test("every integration section is marked, and there are seven of them", () => {
    const markers = PAGE.match(/<TakesEffect /g) ?? [];
    assert.equal(markers.length, 7, "§§ 2, 4, 5, 6, 7, 8 and 9 each carry the marker");
  });

  test("the Sentry row is NOT marked as taking effect later", () => {
    /**
     * The failure this exists to prevent. Sentry has received error reports
     * throughout; a "takes effect 16 November" marker on that row would
     * assert that the processing starts then, which is the opposite of a
     * correction and worse than the omission being corrected.
     */
    const row = PAGE.slice(PAGE.indexOf(">Sentry<"), PAGE.indexOf("Error reports are deliberately"));
    assert.doesNotMatch(row, /TakesEffect/, "the Sentry row was marked as pending");
    assert.match(row, /Added as a correction/);
    // Whitespace-flexible: JSX wraps prose across lines, so a literal-space
    // regex matches the intent and fails on the formatting.
    assert.match(row, /has received error\s+reports throughout/);
  });

  test("the banner says what is in force, not only what is pending", () => {
    const banner = PAGE.slice(PAGE.indexOf("<PendingChangeBanner>"), PAGE.indexOf("</PendingChangeBanner>"));
    // Whitespace-flexible: JSX re-wraps prose, and an assertion that depends
    // on where a line happens to break tests the formatter, not the copy.
    assert.match(banner, /do not\s+apply\s+until then/);
    assert.match(
      banner,
      /including the subprocessor list, is in\s+force now/,
      "without this clause the Sentry row reads as pending too",
    );
  });

  test("the launch scope is named as Outlook, not 'a mailbox'", () => {
    /**
     * Only Outlook mail and calendar work. Gmail is blocked on Google's
     * restricted-scope rules and Google Calendar because the importer
     * speaks only Graph, so copy saying "connect a mailbox or calendar"
     * promises a product that does not exist.
     */
    assert.match(PAGE, /Outlook mail and Outlook Calendar/);
    assert.match(PAGE, /no other mail or calendar\s+provider is supported/);
    assert.doesNotMatch(
      PAGE,
      /connect a mailbox\s+or calendar, Tiny CRM reads/,
      "the generic wording is back",
    );
  });

  test("the region claim is about storage, not about where Sentry is", () => {
    assert.match(PAGE, /our Sentry organisation&rsquo;s Data Storage Region/);
    assert.doesNotMatch(PAGE, /Sentry[^.]{0,40}is based in/);
  });

  test("the Microsoft paragraph does not claim no data flows there", () => {
    assert.match(PAGE, /So traffic does flow to Microsoft/);
    assert.match(PAGE, /do not carry your Tiny CRM records/);
  });

  test("disconnect does not claim Microsoft-side revocation", () => {
    assert.match(PAGE, /does not remove the authorisation you granted at Microsoft/);
    assert.match(PAGE, /both encrypted before they are stored/);
  });

  test("the AI exclusion is scoped to model providers, not to all processing", () => {
    assert.match(PAGE, /never included in a request sent to an AI model\s+provider/);
  });
});
