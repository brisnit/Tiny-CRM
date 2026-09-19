import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { COMPANY_IDENTITY_FIELDS } from "../../src/lib/data/restricted";

/**
 * Every Company column must be classified, forever.
 *
 * Row visibility is enforced by PostgreSQL and cannot be forgotten. The
 * identity projection is enforced by a function, and can be: somebody adds
 * `Company.creditRating` next spring, the projection says nothing about it, and
 * because `companyIdentity` copies a fixed list the new column is simply never
 * returned — safe by accident this time, and the opposite if the projection had
 * been written as a deny-list instead.
 *
 * So this test reads the schema rather than the code. Every scalar column on
 * Company is either identity, scope metadata, or withheld, and a column in none
 * of those three lists fails here with instructions. The decision is cheap; the
 * silence is what costs.
 */

/** Carried for server components; not information about the company. */
const SCOPE_FIELDS = ["workspaceId"];

/**
 * Withheld from restricted members, with the reason. These are not secrets in
 * general — a colleague with full access sees all of them — they are facts
 * about our relationship with the company rather than about the company.
 */
const WITHHELD: Record<string, string> = {
  revenueRange: "commercial intelligence about the account",
  leadSource: "how we came by them, which describes us",
  relationshipStatus: "our pipeline posture",
  type: "our classification of them: client, prospect, vendor",
  description: "free text a colleague wrote; it can say anything",
  ownerId: "which colleague runs the account — D5 keeps the roster private",
  primaryContactId: "points at a person who may be unreachable",
  lastActivityAt: "an activity signal about work they cannot see",
  sourceBatchId: "import provenance",
  archivedAt: "lifecycle state of a record they only partly see",
  version: "optimistic concurrency token for an edit they cannot make",
  createdAt: "when we started tracking them",
  updatedAt: "when a colleague last touched the record",
};

/** Scalar columns of one model, read from the Prisma schema. */
function scalarColumns(model: string): string[] {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const match = new RegExp(`^model ${model} \\{(.*?)^\\}`, "ms").exec(schema);
  assert.ok(match, `the ${model} model is missing from the schema`);

  const columns: string[] = [];
  for (const raw of match[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("///") || line.startsWith("@@")) continue;
    const [name, type] = line.split(/\s+/);
    if (!name || !type) continue;
    // Relations are not columns: their type resolves to another model.
    const base = type.replace(/[?\[\]]/g, "");
    if (!["String", "Int", "Boolean", "DateTime", "Float", "Json", "Decimal", "BigInt"].includes(base)) continue;
    columns.push(name);
  }
  return columns;
}

describe("the restricted company projection is complete", () => {
  test("every Company column is identity, scope, or withheld — with a reason", () => {
    const columns = scalarColumns("Company");
    assert.ok(columns.length > 10, `only ${columns.length} columns were parsed; the parser is wrong`);

    const classified = new Set([...COMPANY_IDENTITY_FIELDS, ...SCOPE_FIELDS, ...Object.keys(WITHHELD)]);
    const unclassified = columns.filter((c) => !classified.has(c));

    assert.deepEqual(
      unclassified,
      [],
      `these Company columns are not classified for restricted members:\n` +
        unclassified.map((c) => `  ${c}`).join("\n") +
        `\n\nAdd each to COMPANY_IDENTITY_FIELDS in src/lib/data/restricted.ts if a ` +
        `restricted member may see it, or to WITHHELD in this file with the reason they may not. ` +
        `A new column is withheld by default — companyIdentity copies an allow-list — so the ` +
        `risk is not exposure, it is that nobody decided.`,
    );
  });

  test("the classification has no entries for columns that no longer exist", () => {
    const columns = new Set(scalarColumns("Company"));
    const stale = [...COMPANY_IDENTITY_FIELDS, ...SCOPE_FIELDS, ...Object.keys(WITHHELD)].filter(
      (c) => !columns.has(c),
    );
    assert.deepEqual(stale, [], `classified columns that are no longer on the model: ${stale.join(", ")}`);
  });

  test("the approved identity list is exactly what was approved", () => {
    // Pinned literally. Widening this is a decision someone should have to make
    // in a diff, not something that drifts as pages ask for one more field.
    assert.deepEqual(
      [...COMPANY_IDENTITY_FIELDS].sort(),
      ["domain", "id", "industry", "location", "logoUrl", "name", "size", "website"],
      "the restricted company identity projection has changed",
    );
  });
});
