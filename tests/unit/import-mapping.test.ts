import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { proposeMapping } from "../../src/lib/import/mapping";
import { TARGETS_BY_KEY } from "../../src/lib/import/targets";

/**
 * The 25 columns of a real RFP tracker, with real values under them.
 *
 * This suite is the honest measure of whether the importer understands a
 * spreadsheet somebody actually works in. It asserts on the columns that
 * matter, on the ones that must NOT be written because Tiny recalculates them,
 * and on the ones it is right to leave alone.
 */

const HEADERS = [
  "RFP ID", "Title", "Agency / Buyer", "Location", "Source", "Deadline", "Days Left",
  "Score", "Verdict", "Status", "Next Action", "Est. Value", "Cross-border", "Full RFP?",
  "Scope /40", "Runway /20", "Platform /15", "Access. /10", "Action. /15", "Notes",
  "CA SB 5% Pref", "SB Option <$250K", "Local / CA Weighted", "SB Bump", "Adjusted Score",
];

const ROWS = [
  ["WD-16154", "Website Design, Development, Implementation, Hosting and Migration Using WordPress CMS",
   "Vancouver Island Economic Alliance (VIEA)", "Canada (British Columbia)", "RFPMart",
   "2026-09-15", "5", "72", "GO", "Sourced", "Decide fast — cross-border setup takes time",
   "unknown", "Yes", "Yes", "38", "4.0", "15", "0", "15",
   "CROSS-BORDER: registration and tax overhead applies.", "FALSE", "FALSE", "FALSE", "0", "72"],
  ["WD-16168", "Website Design, Development and Hosting Service using WordPress CMS",
   "Boulder County", "USA (Colorado)", "RFPMart", "2026-09-18", "8", "70", "LOOK", "Sourced",
   "Pull the full solicitation this week", "unknown", "No", "Yes", "36", "4.0", "15", "0", "15",
   "Clean design-and-build scope on WordPress.", "FALSE", "FALSE", "FALSE", "0", "70"],
  ["RFP-GD-26-005", "Website Redesign", "Inland Empire Utilities Agency", "USA (California)",
   "PlanetBids", "2026-09-28", "18", "—", "BID SUBMITTED", "Sent Clarifying Questions",
   "Confirm the 8/26 addendum is acknowledged", "$239,000", "No", "Yes", "", "", "", "", "",
   "eBid submitted 8/21/26; 12 Q&A questions filed.", "FALSE", "FALSE", "FALSE", "0", ""],
  ["WD-16140", "Web Engineering and UX and UI Development Services using WordPress CMS",
   "Foundation for Advancement in Conservation (FAIC)", "USA (Washington, DC)", "RFPMart",
   "2026-09-30", "20", "78", "GO", "Sourced", "Pull the full solicitation",
   "$30,000-$40,000", "No", "Yes", "34", "14.0", "15", "0", "15",
   "Longest runway of the GO set.", "FALSE", "FALSE", "FALSE", "0", "78"],
];

function mapped(): Map<string, string | null> {
  const proposals = proposeMapping(HEADERS, ROWS);
  return new Map(proposals.map((p) => [p.header, p.targetKey]));
}

describe("understanding a real RFP tracker", () => {
  test("the columns that carry the pipeline are recognised", () => {
    const m = mapped();
    const expected: Record<string, string> = {
      "RFP ID": "opportunity.solicitationNumber",
      "Title": "opportunity.name",
      "Agency / Buyer": "opportunity.company",
      "Source": "opportunity.source",
      "Deadline": "opportunity.proposalDeadlineAt",
      "Status": "opportunity.submissionStatus",
      "Next Action": "task.title",
      "Est. Value": "opportunity.estimatedValueCents",
      "Notes": "opportunity.requirements",
    };
    for (const [header, key] of Object.entries(expected)) {
      assert.equal(m.get(header), key, `"${header}" mapped to ${m.get(header)}`);
    }
  });

  test("derived columns are flagged, not written onto the record", () => {
    // Days Left, Score and Verdict are formulas in the sheet and recalculate
    // every day. Writing the spreadsheet's copy onto the record freezes a value
    // that is supposed to move, and the record then disagrees with itself.
    const proposals = proposeMapping(HEADERS, ROWS);
    for (const header of ["Days Left", "Score", "Verdict"]) {
      const p = proposals.find((x) => x.header === header)!;
      assert.ok(p.targetKey, `"${header}" was not recognised at all`);
      assert.equal(p.derived, true, `"${header}" is not flagged as derived`);
      const target = TARGETS_BY_KEY.get(p.targetKey!)!;
      assert.equal(target.derived, true);
    }
  });

  test("a derived column explains itself", () => {
    const proposals = proposeMapping(HEADERS, ROWS);
    const score = proposals.find((p) => p.header === "Score")!;
    assert.match(score.reason, /recalculat/i, `reason was: ${score.reason}`);
  });

  test("no two columns claim the same field", () => {
    // "Score" and "Adjusted Score" both look like a fit score; "Deadline" and
    // "Days Left" both look like a deadline. Letting both through means one
    // write silently wins and the person never learns which.
    const proposals = proposeMapping(HEADERS, ROWS);
    const keys = proposals.map((p) => p.targetKey).filter(Boolean) as string[];
    assert.equal(new Set(keys).size, keys.length, `duplicate targets: ${keys.join(", ")}`);
  });

  test("the scoring component columns are left unmapped rather than forced", () => {
    // Scope /40, Runway /20, Platform /15 and the small-business columns are
    // this business's own scoring model. Tiny has no field that means them, and
    // inventing one would be worse than leaving them for the person to place.
    const m = mapped();
    for (const header of ["Scope /40", "Platform /15", "Access. /10", "CA SB 5% Pref", "SB Bump"]) {
      assert.equal(m.get(header), null, `"${header}" was forced onto ${m.get(header)}`);
    }
  });

  test("an unmapped column says so in words", () => {
    const proposals = proposeMapping(HEADERS, ROWS);
    const p = proposals.find((x) => x.header === "Scope /40")!;
    assert.equal(p.confidence, 0);
    assert.match(p.reason, /No field matched|will not be imported/i);
  });

  test("every proposal carries samples the person can check against", () => {
    const proposals = proposeMapping(HEADERS, ROWS);
    const deadline = proposals.find((p) => p.header === "Deadline")!;
    assert.ok(deadline.samples.includes("2026-09-15"), `samples were ${JSON.stringify(deadline.samples)}`);
    assert.match(deadline.reason, /values read as dates/i);
  });

  test("a header that lies is caught by the values under it", () => {
    // The header says deadline; the column is prose. Confidence should fall
    // rather than the mapping being taken at face value.
    const honest = proposeMapping(["Deadline"], [["2026-09-15"], ["2026-10-01"]])[0]!;
    const lying = proposeMapping(["Deadline"], [["whenever they get to it"], ["ask Andrew"]])[0]!;
    assert.ok(
      lying.confidence < honest.confidence,
      `prose column scored ${lying.confidence} vs ${honest.confidence}`,
    );
  });

  test("a clean CRM export maps without ceremony", () => {
    const proposals = proposeMapping(
      ["First Name", "Last Name", "Email", "Company", "Phone"],
      [["Ada", "Lovelace", "ada@example.com", "Analytical Engines", "555-0100"]],
    );
    const m = new Map(proposals.map((p) => [p.header, p.targetKey]));
    assert.equal(m.get("First Name"), "contact.firstName");
    assert.equal(m.get("Last Name"), "contact.lastName");
    assert.equal(m.get("Email"), "contact.email");
    assert.equal(m.get("Phone"), "contact.phone");
  });

  test("mapping is keyed by column position, not header text", () => {
    // Two columns called "Notes" is a thing real files do. Keying by name means
    // the second silently overwrites the first.
    const proposals = proposeMapping(["Notes", "Notes"], [["a", "b"]]);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0]!.index, 0);
    assert.equal(proposals[1]!.index, 1);
    assert.notEqual(
      proposals[0]!.targetKey && proposals[1]!.targetKey,
      true,
      "both duplicate columns claimed the same field",
    );
  });
});
