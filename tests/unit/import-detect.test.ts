import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { detectTable, type RawSheet } from "../../src/lib/import/detect";

/**
 * These fixtures are the real shape of a spreadsheet a business is run from,
 * taken from an actual RFP tracker rather than invented: a title, a paragraph
 * describing the tab, an instruction about which cells are editable, a blank
 * row, then the header — and three paragraphs of footnotes underneath the
 * data.
 *
 * Every one of these was a case the previous importer would have got wrong,
 * because it treats row one as the header unconditionally.
 */

const REAL_HEADERS = [
  "RFP ID", "Title", "Agency / Buyer", "Location", "Source", "Deadline", "Days Left",
  "Score", "Verdict", "Status", "Next Action", "Est. Value", "Cross-border", "Full RFP?",
  "Scope /40", "Runway /20", "Platform /15", "Access. /10", "Action. /15", "Notes",
  "CA SB 5% Pref", "SB Option <$250K", "Local / CA Weighted", "SB Bump", "Adjusted Score",
];

const pad = (cells: string[]) => {
  const row = [...cells];
  while (row.length < REAL_HEADERS.length) row.push("");
  return row;
};

const wide = (text: string) => pad([text]);

function rfpSheet(): RawSheet {
  return {
    name: "RFPs",
    rows: [
      wide("Artifact Digital — RFP Pipeline"),
      wide(
        "Sourced from the RFPMart weekly digest of 25/Aug/2026 (1,169 listings across 38 " +
          "categories) plus PlanetBids. GO and LOOK listings only — PASS and hard-gated items " +
          "are not carried here. Scoring: Scope 40 · Runway 20 · Platform 15 · Accessibility 10.",
      ),
      wide(
        "Edit the blue cells only. Days Left, Runway, Score and Verdict are formulas and " +
          "re-calculate every day — a verdict can move from GO to LOOK as a deadline closes in.",
      ),
      pad([]),
      REAL_HEADERS,
      pad([
        "WD-16154",
        "Website Design, Development, Implementation, Hosting, Deployment and Migration Service Using WordPress CMS",
        "Vancouver Island Economic Alliance (VIEA)", "Canada (British Columbia)", "RFPMart",
        "2026-09-15", "5", "72", "GO", "Sourced",
        "Decide fast — under three weeks, and cross-border setup takes time",
        "unknown", "Yes", "Yes", "38", "4.0", "15", "0", "15",
        "CROSS-BORDER: same registration, tax and threshold overhead as the Ontario listings.",
        "FALSE", "FALSE", "FALSE", "0", "72",
      ]),
      pad([
        "WD-16168", "Website Design, Development, Deployment, Implementation and Hosting Service using WordPress CMS",
        "Boulder County", "USA (Colorado)", "RFPMart", "2026-09-18", "8", "70", "LOOK", "Sourced",
        "Pull the full solicitation this week — runway is under three weeks",
        "unknown", "No", "Yes", "36", "4.0", "15", "0", "15",
        "Clean design-and-build scope on WordPress.", "FALSE", "FALSE", "FALSE", "0", "70",
      ]),
      // The messy ones, verbatim in shape.
      pad([
        "Higer Ed Work", "We are designing an OS for higher education ",
        "Fuller, Jessup, Evangel & San Jose State ", "USA", "Andrew", "NA", "NA", "100", "GO", "",
        "Meet with team schedule meetings- We have hot leads", "Millions", "not yet", "NA",
        "", "", "", "", "", "", "FALSE", "FALSE", "FALSE", "0", "100",
      ]),
      pad(["Homwood", "designing ", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "FALSE", "FALSE", "FALSE", "0", ""]),
      // Footnotes: one long cell, everything else blank.
      wide(
        "Agency / Buyer and Est. Value are now read from the purchased solicitations themselves, " +
          "not the digest — all 21 RFPMart rows here have been bought and the documents are filed " +
          "in Desktop/RFPs, one folder per RFP ID. Only three solicitations state a budget.",
      ),
      wide(
        "Gated out of this tab and not shown: WD-16139 (Drupal hosting/support only), WD-16160 " +
          "(IT support only), WD-16161 (hosting/maintenance/support only), plus the SEO, signage " +
          "and mobile-app categories, none of which are design or build engagements.",
      ),
    ],
  };
}

function rollupSheet(): RawSheet {
  return {
    name: "RFP Rollup",
    rows: [
      ["Artifact Digital — RFP Rollup", "", ""],
      ["Every figure below reads from the RFPs tab. Nothing to edit here.", "", ""],
      ["", "", ""],
      ["PIPELINE BY VERDICT", "", ""],
      ["Total opportunities tracked", "24", "Every row on the RFPs tab."],
      ["GO (score 72+)", "13", "Worth building a response for."],
      ["LOOK (score 50–71)", "7", "Read the solicitation before deciding."],
      ["PASS (below 50)", "2", "Starts at zero."],
      ["Bid submitted", "1", "Response filed, awaiting award."],
      ["Closing within 7 days", "4", "Decide now or drop."],
      ["Closing within 14 days", "10", "Runway multiplier is already penalising these."],
      ["Cross-border (Canada)", "1", "Registration and withholding overhead applies."],
      ["Known pipeline value", "$239,000", "Only the IEUA bid carries a real figure."],
    ],
  };
}

describe("finding the table inside a working spreadsheet", () => {
  test("the header is found under the title and the instructions", () => {
    const table = detectTable(rfpSheet());
    assert.equal(table.headerRow, 4, "the header row was not located");
    assert.equal(table.headers[0], "RFP ID");
    assert.equal(table.headers.length, 25);
  });

  test("the preamble is kept, not silently dropped", () => {
    const table = detectTable(rfpSheet());
    assert.equal(table.preamble.length, 3, "expected the title and two note rows");
    assert.match(table.preamble[0]![0]!, /Artifact Digital/);
  });

  test("the prose row is not mistaken for the header", () => {
    // The failure this prevents: row 1 is the first row with text, so a parser
    // that takes "the first non-empty row" produces a single-column table whose
    // one header is a paragraph.
    const table = detectTable(rfpSheet());
    assert.notEqual(table.headerRow, 0);
    assert.ok(
      !table.headers.some((h) => h.length > 60),
      `a paragraph was chosen as a header: ${table.headers.find((h) => h.length > 60)?.slice(0, 60)}`,
    );
  });

  test("footnotes under the data are excluded from the records", () => {
    const table = detectTable(rfpSheet());
    assert.equal(table.rows.length, 4, "footnote paragraphs were counted as records");
    assert.equal(table.trailing.length, 2, "the footnotes were dropped rather than reported");
    assert.match(table.trailing[0]![0]!, /purchased solicitations/);
  });

  test("sparse and malformed rows are still records", () => {
    // "Homwood" has two cells filled out of twenty-five. It is a real row the
    // person typed and abandoned, and dropping it would lose data silently —
    // the preview is where it should be flagged, not the parser.
    const table = detectTable(rfpSheet());
    const ids = table.rows.map((r) => r[0]);
    assert.ok(ids.includes("Homwood"), "a sparse row was discarded");
    assert.ok(ids.includes("Higer Ed Work"), "a row with NA values was discarded");
  });

  test("a rollup tab is recognised as a summary, not as records", () => {
    // Importing this produces a company called "Closing within 7 days".
    const table = detectTable(rollupSheet());
    assert.equal(table.shape, "summary", `rollup classified as ${table.shape}: ${table.reason}`);
    assert.match(table.reason, /rollup|summary/i);
  });

  test("the records tab is recognised as records", () => {
    const table = detectTable(rfpSheet());
    assert.equal(table.shape, "records", table.reason);
    assert.match(table.reason, /4 rows/);
  });

  test("an empty sheet says so rather than inventing a table", () => {
    const table = detectTable({ name: "Sheet3", rows: [["", ""], ["", ""]] });
    assert.equal(table.shape, "empty");
    assert.equal(table.rows.length, 0);
  });

  test("a clean CRM export still works", () => {
    // The regression risk of all of the above: a plain export has no preamble,
    // and the header really is row one.
    const table = detectTable({
      name: "contacts.csv",
      rows: [
        ["First Name", "Last Name", "Email", "Company"],
        ["Ada", "Lovelace", "ada@example.com", "Analytical Engines"],
        ["Alan", "Turing", "alan@example.com", "NPL"],
      ],
    });
    assert.equal(table.headerRow, 0);
    assert.equal(table.shape, "records");
    assert.equal(table.rows.length, 2);
    assert.equal(table.preamble.length, 0);
  });
});
