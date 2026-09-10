import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * The half of the importer that needs a database: what actually gets written,
 * what a rollback takes back, and what it must not touch.
 *
 * The CSV is the real tracker's shape — preamble, footnote, formula columns,
 * a range, prose in a money column, an unmappable status and an abandoned row.
 */

const CSV = `Artifact Digital — RFP Pipeline,,,,,,,,,
"Edit the blue cells only. Days Left, Score and Verdict are formulas.",,,,,,,,,
,,,,,,,,,
RFP ID,Title,Agency / Buyer,Source,Deadline,Days Left,Score,Verdict,Status,Next Action
WD-16154,Website Design and Migration,Vancouver Island Economic Alliance,RFPMart,2026-09-15,5,72,GO,Sourced,Decide fast
WD-16168,Website Design and Hosting,Boulder County,RFPMart,2026-09-18,8,70,LOOK,Sourced,Pull the solicitation
WD-16170,Website Design and Management,Boulder County,RFPMart,2026-09-20,10,82,GO,Sourced,Read this week
Homwood,designing,,,,,,,,
"Footnote: unpurchased listings were removed on 08-Sep-2026.",,,,,,,,,
`;

let A: Tenant;
let B: Tenant;

describe("committing and undoing an import", () => {
  before(async () => {
    A = await createTenant("ImportAlpha");
    B = await createTenant("ImportBeta");
    // The fixture owner is on the free plan, which allows five opportunities —
    // correct for a real account and too small for a suite that imports the
    // same file repeatedly. The plan is raised on the fixture rather than the
    // ceiling being lowered in the code; the free-plan behaviour gets its own
    // test below.
    await db.user.updateMany({ where: { id: { in: [A.ownerId, B.ownerId] } }, data: { plan: "pro" } });
  });
  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

  /**
   * The import policy allows five per ten minutes, which is right for a person
   * and wrong for a suite that imports in every test. Cleared through the
   * limiter's own reset rather than by loosening the policy — the ceiling that
   * protects production stays exactly where it is.
   */
  async function clearLimiter() {
    for (const id of [A.ownerId, B.ownerId, A.workspaceId, B.workspaceId]) {
      await resetRateLimit("import", { user: id, workspace: id, global: id });
    }
  }

  async function analyze(content = CSV) {
    await clearLimiter();
    const { analyzeSpreadsheet } = await import("../../src/lib/actions/import-batches");
    const result = await asOwner(() =>
      analyzeSpreadsheet({ workspaceId: A.workspaceId, fileName: "rfps.csv", content }),
    );
    assert.equal(result.ok, true, `analyze failed: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error("unreachable");
    return result.data;
  }

  async function commit(batchId: string) {
    await clearLimiter();
    const { commitImport } = await import("../../src/lib/actions/import-batches");
    return asOwner(() => commitImport({ workspaceId: A.workspaceId, batchId }));
  }

  test("the preview describes the file before anything is written", async () => {
    const before = await db.opportunity.count({ where: { workspaceId: A.workspaceId } });
    const preview = await analyze();

    assert.equal(preview.summary.rows, 4, "the footnote or preamble was counted as a record");
    assert.equal(preview.summary.byEntity.opportunity, 4);
    assert.equal(preview.summary.byEntity.company, 2, "distinct agencies were miscounted");
    assert.deepEqual(preview.summary.derivedColumns.sort(), ["Days Left", "Score", "Verdict"]);

    const after = await db.opportunity.count({ where: { workspaceId: A.workspaceId } });
    assert.equal(after, before, "previewing wrote records");
  });

  test("the staged rows keep the source values the record will not carry", async () => {
    const preview = await analyze();
    const rows = await db.importRow.findMany({
      where: { batchId: preview.batchId },
      orderBy: { rowIndex: "asc" },
      select: { raw: true },
    });
    const first = JSON.parse(rows[0]!.raw) as Record<string, string>;
    assert.equal(first["Score"], "72", "the source score was not preserved");
    assert.equal(first["Verdict"], "GO");
    assert.equal(first["Days Left"], "5");
  });

  test("committing writes the records and links them together", async () => {
    const preview = await analyze();
    const result = await commit(preview.batchId);
    assert.equal(result.ok, true, `commit failed: ${JSON.stringify(result)}`);

    const opportunities = await db.opportunity.findMany({
      where: { workspaceId: A.workspaceId, sourceBatchId: preview.batchId },
      select: { name: true, solicitationNumber: true, companyId: true, proposalDeadlineAt: true, deadlineAt: true, fitScore: true },
    });
    assert.equal(opportunities.length, 4);

    const wd = opportunities.find((o) => o.solicitationNumber === "WD-16154")!;
    assert.ok(wd.companyId, "the opportunity was not linked to its agency");
    assert.equal(wd.proposalDeadlineAt?.toISOString().slice(0, 10), "2026-09-15");
    assert.equal(wd.deadlineAt?.toISOString().slice(0, 10), "2026-09-15", "deadlineAt was not derived");
    assert.equal(wd.fitScore, null, "the spreadsheet's score was written onto the record");

    // Boulder County appears on two rows and must become one company.
    const companies = await db.company.findMany({
      where: { workspaceId: A.workspaceId, sourceBatchId: preview.batchId },
      select: { name: true },
    });
    // Boulder County is named on two rows and must be one company.
    assert.equal(companies.length, 2, `expected 2 companies, got ${companies.map((c) => c.name).join(", ")}`);

    const tasks = await db.task.findMany({
      where: { workspaceId: A.workspaceId, sourceBatchId: preview.batchId },
      select: { title: true, opportunityId: true },
    });
    assert.equal(tasks.length, 3, "the abandoned row produced a task");
    assert.ok(tasks.every((t) => t.opportunityId), "a task was not attached to its opportunity");
  });

  test("a second import matches the existing company instead of duplicating it", async () => {
    const first = await analyze();
    await commit(first.batchId);

    const second = await analyze();
    assert.ok(second.duplicates.length > 0, "the existing companies were not reported");

    await commit(second.batchId);
    const boulder = await db.company.findMany({
      where: { workspaceId: A.workspaceId, name: "Boulder County" },
      select: { id: true },
    });
    assert.equal(boulder.length, 1, "re-importing duplicated a company");
  });

  test("rollback removes exactly what the import created", async () => {
    // A record that existed first, and one made afterwards. Neither belongs to
    // the batch and neither may be taken by undoing it.
    const preexisting = await db.company.create({
      data: { workspaceId: A.workspaceId, name: "Already Here", ownerId: A.ownerId },
      select: { id: true },
    });

    const preview = await analyze();
    await commit(preview.batchId);

    const afterwards = await db.opportunity.create({
      data: { workspaceId: A.workspaceId, name: "Typed by hand", ownerId: A.ownerId },
      select: { id: true },
    });

    const { rollbackImport } = await import("../../src/lib/actions/import-batches");
    await clearLimiter();
    const result = await asOwner(() => rollbackImport({ workspaceId: A.workspaceId, batchId: preview.batchId }));
    assert.equal(result.ok, true, `rollback failed: ${JSON.stringify(result)}`);

    const left = await db.opportunity.count({
      where: { workspaceId: A.workspaceId, sourceBatchId: preview.batchId },
    });
    assert.equal(left, 0, "the import's records survived the rollback");

    assert.ok(
      await db.company.findUnique({ where: { id: preexisting.id } }),
      "rollback deleted a company that was there before the import",
    );
    assert.ok(
      await db.opportunity.findUnique({ where: { id: afterwards.id } }),
      "rollback deleted a record created after the import",
    );

    const batch = await db.importBatch.findUnique({
      where: { id: preview.batchId },
      select: { status: true, rolledBackAt: true },
    });
    assert.equal(batch?.status, "rolled_back");
    assert.ok(batch?.rolledBackAt);
  });

  test("a rolled-back import cannot be committed again", async () => {
    const preview = await analyze();
    await commit(preview.batchId);
    const { rollbackImport } = await import("../../src/lib/actions/import-batches");
    await clearLimiter();
    await asOwner(() => rollbackImport({ workspaceId: A.workspaceId, batchId: preview.batchId }));

    const again = await commit(preview.batchId);
    assert.equal(again.ok, false, "a rolled-back batch was replayed");
  });

  test("committing twice does not write the rows twice", async () => {
    const preview = await analyze();
    await commit(preview.batchId);
    const second = await commit(preview.batchId);
    assert.equal(second.ok, false, "the batch committed a second time");

    const count = await db.opportunity.count({
      where: { workspaceId: A.workspaceId, sourceBatchId: preview.batchId },
    });
    assert.equal(count, 4, "records were duplicated by a second commit");
  });

  test("another tenant cannot read, commit or roll back the batch", async () => {
    const preview = await analyze();
    const { commitImport, rollbackImport, updateImportMapping } =
      await import("../../src/lib/actions/import-batches");

    await clearLimiter();
    const asIntruder = <T>(fn: () => Promise<T>) => runAsTestIdentity(B.ownerId, fn);

    for (const attempt of [
      () => asIntruder(() => commitImport({ workspaceId: B.workspaceId, batchId: preview.batchId })),
      () => asIntruder(() => rollbackImport({ workspaceId: B.workspaceId, batchId: preview.batchId })),
      () => asIntruder(() =>
        updateImportMapping({ workspaceId: B.workspaceId, batchId: preview.batchId, mapping: [] })),
    ]) {
      const result = await attempt();
      assert.equal(result.ok, false, "another workspace reached this batch");
    }

    // And nothing of A's batch was created under B.
    const leaked = await db.opportunity.count({
      where: { workspaceId: B.workspaceId, sourceBatchId: preview.batchId },
    });
    assert.equal(leaked, 0, "the batch wrote into another workspace");
  });

  test("a plan limit stops the whole import rather than filling up to the cap", async () => {
    // Partially importing until a ceiling is hit is the worst outcome: a
    // pipeline that is neither the spreadsheet's nor Tiny's, with no way to
    // tell which rows made it.
    const free = await createTenant("ImportFree");
    try {
      await db.user.updateMany({ where: { id: free.ownerId }, data: { plan: "free" } });
      const beforeCount = await db.opportunity.count({ where: { workspaceId: free.workspaceId } });

      const { analyzeSpreadsheet, commitImport } = await import("../../src/lib/actions/import-batches");
      await resetRateLimit("import", { user: free.ownerId, workspace: free.workspaceId, global: free.ownerId });

      const many = [
        "RFP ID,Title,Agency / Buyer,Deadline",
        ...Array.from({ length: 40 }, (_, i) => `R-${i},Opportunity ${i},Agency ${i},2026-10-01`),
      ].join("\n");

      const previewed = await runAsTestIdentity(free.ownerId, () =>
        analyzeSpreadsheet({ workspaceId: free.workspaceId, fileName: "big.csv", content: many }),
      );
      assert.equal(previewed.ok, true, JSON.stringify(previewed));
      if (!previewed.ok) throw new Error("unreachable");

      // The preview says so before anything is written.
      assert.ok(previewed.data.planProblem, "the preview did not warn about the plan limit");

      await resetRateLimit("import", { user: free.ownerId, workspace: free.workspaceId, global: free.ownerId });
      const result = await runAsTestIdentity(free.ownerId, () =>
        commitImport({ workspaceId: free.workspaceId, batchId: previewed.data.batchId }),
      );
      assert.equal(result.ok, false, "the import committed past the plan limit");
      if (!result.ok) assert.equal(result.category, "plan_limit", JSON.stringify(result));

      const afterCount = await db.opportunity.count({ where: { workspaceId: free.workspaceId } });
      assert.equal(afterCount, beforeCount, "rows were written before the limit stopped it");
    } finally {
      await cleanupTenants([free]);
    }
  });

  test("a formula in a cell is stored inert", async () => {
    const hostile = CSV.replace("Website Design and Migration", '=HYPERLINK("http://attacker","Click")');
    const preview = await analyze(hostile);
    const result = await commit(preview.batchId);
    assert.equal(result.ok, true);

    const opportunity = await db.opportunity.findFirst({
      where: { workspaceId: A.workspaceId, sourceBatchId: preview.batchId, solicitationNumber: "WD-16154" },
      select: { name: true },
    });
    assert.ok(opportunity, "the row did not import");
    assert.ok(
      !opportunity!.name.startsWith("="),
      `a live formula was stored: ${opportunity!.name}`,
    );
  });
});
