import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseCsvGrid } from "../../src/lib/csv";
import { detectTable } from "../../src/lib/import/detect";
import { proposeMapping } from "../../src/lib/import/mapping";
import { planRows, summarise, type ColumnMapping } from "../../src/lib/import/plan";

/**
 * The whole pure pipeline, end to end, over a CSV that is a faithful copy of a
 * real RFP tracker — preamble, footnotes, formula columns, ranges, "Millions",
 * a status outside the enum, commas inside quoted fields, and a row somebody
 * started and abandoned.
 *
 * If this suite passes, the only things left between here and real data are
 * the database and the UI.
 */

const CSV = `Artifact Digital — RFP Pipeline,,,,,,,,,,,
"Sourced from the RFPMart weekly digest of 25/Aug/2026 (1,169 listings across 38 categories) plus PlanetBids. GO and LOOK listings only.",,,,,,,,,,,
"Edit the blue cells only. Days Left, Score and Verdict are formulas and re-calculate every day.",,,,,,,,,,,
,,,,,,,,,,,
RFP ID,Title,Agency / Buyer,Location,Source,Deadline,Days Left,Score,Verdict,Status,Next Action,Est. Value
WD-16154,"Website Design, Development, Implementation and Migration Using WordPress CMS",Vancouver Island Economic Alliance (VIEA),Canada (British Columbia),RFPMart,2026-09-15,5,72,GO,Sourced,Decide fast — cross-border setup takes time,unknown
WD-16168,"Website Design, Development and Hosting using WordPress CMS",Boulder County,USA (Colorado),RFPMart,2026-09-18,8,70,LOOK,Sourced,Pull the full solicitation this week,unknown
RFP-GD-26-005,Website Redesign,Inland Empire Utilities Agency,USA (California),PlanetBids,2026-09-28,18,—,BID SUBMITTED,Sent Clarifying Questions,Confirm the addendum is acknowledged,"$239,000"
WD-16140,Web Engineering and UX and UI Development Services,Foundation for Advancement in Conservation (FAIC),"USA (Washington, DC)",RFPMart,2026-09-30,20,78,GO,Sourced,Pull the full solicitation,"$30,000-$40,000"
Higer Ed Work,We are designing an OS for higher education,"Fuller, Jessup, Evangel & San Jose State",USA,Andrew,NA,NA,100,GO,,Meet with team — we have hot leads,Millions
Homwood,designing,,,,,,,,,,
"Agency / Buyer and Est. Value are now read from the purchased solicitations themselves, not the digest — all 21 RFPMart rows here have been bought and the documents are filed one folder per RFP ID.",,,,,,,,,,,
`;

function pipeline() {
  const grid = parseCsvGrid(CSV);
  const table = detectTable({ name: "RFPs", rows: grid });
  const proposals = proposeMapping(table.headers, table.rows);
  const mapping: ColumnMapping = proposals.map((p) => ({ index: p.index, targetKey: p.targetKey }));
  const plans = planRows(table.headers, table.rows, mapping);
  const summary = summarise(table.headers, table.rows, mapping, plans);
  return { table, proposals, mapping, plans, summary };
}

describe("a real tracker, from CSV text to a plan", () => {
  test("the table is found under the preamble and above the footnote", () => {
    const { table } = pipeline();
    assert.equal(table.shape, "records");
    assert.equal(table.headers[0], "RFP ID");
    assert.equal(table.rows.length, 6, "wrong number of records");
    assert.equal(table.preamble.length, 3);
    assert.equal(table.trailing.length, 1);
  });

  test("commas inside quoted fields do not shift the columns", () => {
    // "Fuller, Jessup, Evangel & San Jose State" is one cell. If quoting is
    // mishandled every column after it is off by two and the deadline lands in
    // the source column.
    const { table } = pipeline();
    const row = table.rows.find((r) => r[0] === "Higer Ed Work")!;
    assert.equal(row[2], "Fuller, Jessup, Evangel & San Jose State");
    assert.equal(row[4], "Andrew", "columns shifted after the quoted comma");
  });

  test("each real row becomes an opportunity, a company and a task", () => {
    const { plans } = pipeline();
    const first = plans.find((p) => p.raw["RFP ID"] === "WD-16154")!;
    const entities = first.drafts.map((d) => d.entity).sort();
    assert.deepEqual(entities, ["company", "opportunity", "task"]);

    const company = first.drafts.find((d) => d.entity === "company")!;
    assert.equal(company.values.name, "Vancouver Island Economic Alliance (VIEA)");

    const opportunity = first.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(opportunity.values.solicitationNumber, "WD-16154");
    assert.match(String(opportunity.values.name), /^Website Design, Development/);
    assert.equal(opportunity.referenceName, "Vancouver Island Economic Alliance (VIEA)");
    assert.equal(
      (opportunity.values.proposalDeadlineAt as Date).toISOString().slice(0, 10),
      "2026-09-15",
    );

    const task = first.drafts.find((d) => d.entity === "task")!;
    assert.match(String(task.values.title), /Decide fast/);
  });

  test("the formula columns are not written onto the record", () => {
    const { plans, summary } = pipeline();
    const first = plans.find((p) => p.raw["RFP ID"] === "WD-16154")!;
    const opportunity = first.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(opportunity.values.fitScore, undefined, "the spreadsheet's score was written");
    assert.ok(summary.derivedColumns.includes("Score"));
    assert.ok(summary.derivedColumns.includes("Days Left"));
    assert.ok(summary.derivedColumns.includes("Verdict"));
  });

  test("but the source values survive on the row, so they can be compared", () => {
    // Decision: preserve, do not overwrite. The person wants to see what the
    // spreadsheet said next to what Tiny now says.
    const { plans } = pipeline();
    const first = plans.find((p) => p.raw["RFP ID"] === "WD-16154")!;
    assert.equal(first.raw["Score"], "72");
    assert.equal(first.raw["Verdict"], "GO");
    assert.equal(first.raw["Days Left"], "5");
  });

  test("a status outside the vocabulary is refused, not snapped to the nearest", () => {
    // On this row the real sheet carries Verdict "BID SUBMITTED" and Status
    // "Sent Clarifying Questions". The second is a real working state that
    // Tiny has no equivalent for, and guessing "drafting" would move a live
    // bid. It is refused, reported, and the field left unset.
    const { plans } = pipeline();
    const row = plans.find((p) => p.raw["RFP ID"] === "RFP-GD-26-005")!;
    assert.equal(row.raw["Status"], "Sent Clarifying Questions");

    const opportunity = row.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(opportunity.values.submissionStatus, undefined, "a status was guessed");
    assert.ok(
      row.issues.some((i) => i.column === "Status" && /not one of/i.test(i.reason)),
      `the refusal was not reported: ${JSON.stringify(row.issues)}`,
    );
  });

  test("a status the vocabulary does cover is translated and explained", () => {
    const { plans } = pipeline();
    const row = plans.find((p) => p.raw["RFP ID"] === "WD-16154")!;
    const opportunity = row.drafts.find((d) => d.entity === "opportunity")!;
    // "Sourced" is a declared alias for not_started.
    assert.equal(opportunity.values.submissionStatus, "not_started");
    assert.ok(
      row.issues.some((i) => i.column === "Status" && /Read "Sourced" as not_started/.test(i.reason)),
      "the translation was applied without saying so",
    );
  });

  test("money that cannot be read becomes an issue, not a number", () => {
    const { plans } = pipeline();

    const real = plans.find((p) => p.raw["RFP ID"] === "RFP-GD-26-005")!;
    const realOpportunity = real.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(realOpportunity.values.estimatedValueCents, 23_900_000);

    const range = plans.find((p) => p.raw["RFP ID"] === "WD-16140")!;
    const rangeOpportunity = range.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(rangeOpportunity.values.estimatedValueCents, undefined, "a range became a figure");
    assert.ok(
      range.issues.some((i) => i.column === "Est. Value" && /range/i.test(i.reason)),
      "the range was dropped without a word",
    );

    const prose = plans.find((p) => p.raw["RFP ID"] === "Higer Ed Work")!;
    assert.ok(
      prose.issues.some((i) => i.column === "Est. Value" && /amount/i.test(i.reason)),
      '"Millions" was not reported',
    );
  });

  test("an unreadable deadline does not stop the row importing", () => {
    // The Higer Ed row has "NA" for a deadline. It is still a real opportunity
    // and importing it without a deadline is right; dropping it is not.
    const { plans } = pipeline();
    const row = plans.find((p) => p.raw["RFP ID"] === "Higer Ed Work")!;
    assert.equal(row.decision, "create");
    const opportunity = row.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(opportunity.values.proposalDeadlineAt, undefined);
  });

  test("the abandoned row still becomes a record rather than vanishing", () => {
    const { plans } = pipeline();
    const row = plans.find((p) => p.raw["RFP ID"] === "Homwood")!;
    assert.equal(row.decision, "create", "a sparse row was silently dropped");
    const opportunity = row.drafts.find((d) => d.entity === "opportunity")!;
    assert.equal(opportunity.values.name, "designing");
    assert.equal(row.drafts.some((d) => d.entity === "task"), false, "an empty task was invented");
  });

  test("the summary names what will not be imported", () => {
    const { summary } = pipeline();
    assert.equal(summary.rows, 6);
    assert.equal(summary.byEntity.opportunity, 6);
    assert.equal(summary.byEntity.company, 5, "the row with no agency should not make a company");
    assert.equal(summary.byEntity.task, 5);
    assert.deepEqual(summary.derivedColumns.sort(), ["Days Left", "Score", "Verdict"]);
  });

  test("the plan is the same every time it is built", () => {
    // The preview and the commit must be the same computation. If this drifts,
    // a person approves one thing and gets another — the exact defect the
    // staged batch exists to prevent.
    const a = pipeline();
    const b = pipeline();
    assert.deepEqual(JSON.stringify(a.plans), JSON.stringify(b.plans));
  });
});
