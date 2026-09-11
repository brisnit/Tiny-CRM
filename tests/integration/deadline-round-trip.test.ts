import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * A deadline must survive being saved, read back, and saved again.
 *
 * The unit tests pin the formatters. This pins the path a person actually
 * takes: create through the real action, read what the edit form would be
 * pre-filled with, save that back through the real action, and check the day
 * has not moved. In Pacific it used to move one day per round trip, so a
 * record edited twice for an unrelated reason had its deadline two days early.
 *
 * The formatting half runs in a child process with TZ set, because a process
 * cannot change its own timezone after the date code has initialised.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const ZONES = ["America/Los_Angeles", "America/New_York", "UTC", "Europe/London", "Asia/Tokyo"];

/** What the edit form would show for a stored value, in a given timezone. */
function prefillIn(tz: string, iso: string): string {
  return execFileSync(
    "npx",
    ["tsx", "--eval",
     `import { dateOnlyInputValue } from "./src/lib/dates";
      process.stdout.write(dateOnlyInputValue(new Date("${iso}")));`],
    { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: "utf8" },
  ).trim();
}

let A: Tenant;

describe("a calendar date survives the round trip", () => {
  before(async () => {
    A = await createTenant("DeadlineAlpha");
    await db.user.updateMany({ where: { id: A.ownerId }, data: { plan: "pro" } });
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

  test("an RFP deadline entered as 2026-09-29 stays 2026-09-29", async () => {
    const { createOpportunity, updateOpportunity } = await import("../../src/lib/actions/opportunities");

    const created = await asOwner(() =>
      createOpportunity({
        workspaceId: A.workspaceId,
        name: "Deadline probe",
        proposalDeadlineAt: "2026-09-29",
      }),
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;

    const stored = await db.opportunity.findUniqueOrThrow({
      where: { id: created.data.id },
      select: { proposalDeadlineAt: true, deadlineAt: true, version: true },
    });
    assert.equal(stored.proposalDeadlineAt?.toISOString(), "2026-09-29T00:00:00.000Z");
    assert.equal(stored.deadlineAt?.toISOString(), "2026-09-29T00:00:00.000Z", "the derived deadline drifted");

    // Every timezone pre-fills the day that was stored.
    for (const tz of ZONES) {
      assert.equal(
        prefillIn(tz, stored.proposalDeadlineAt!.toISOString()),
        "2026-09-29",
        `${tz} would pre-fill the wrong day`,
      );
    }

    // Save it back unchanged, the way an edit dialog does.
    const saved = await asOwner(() =>
      updateOpportunity(created.data.id, {
        version: stored.version,
        proposalDeadlineAt: "2026-09-29",
      }),
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const after = await db.opportunity.findUniqueOrThrow({
      where: { id: created.data.id },
      select: { proposalDeadlineAt: true },
    });
    assert.equal(
      after.proposalDeadlineAt?.toISOString(),
      "2026-09-29T00:00:00.000Z",
      "saving the record moved its deadline",
    );
  });

  test("a task due date, a project date and a follow-up all hold their day", async () => {
    const { createTask } = await import("../../src/lib/actions/tasks");
    const { createProject } = await import("../../src/lib/actions/projects");
    const { createContact } = await import("../../src/lib/actions/contacts");

    const task = await asOwner(() =>
      createTask({ workspaceId: A.workspaceId, title: "Due probe", dueAt: "2026-09-29" }),
    );
    assert.equal(task.ok, true, JSON.stringify(task));

    const project = await asOwner(() =>
      createProject({ workspaceId: A.workspaceId, name: "Date probe", targetDate: "2026-09-29", startDate: "2026-01-01" }),
    );
    assert.equal(project.ok, true, JSON.stringify(project));

    const contact = await asOwner(() =>
      createContact({ workspaceId: A.workspaceId, firstName: "Follow", lastName: "Up", nextFollowUpAt: "2026-09-29" }),
    );
    assert.equal(contact.ok, true, JSON.stringify(contact));

    const rows = await Promise.all([
      db.task.findFirst({ where: { workspaceId: A.workspaceId, title: "Due probe" }, select: { dueAt: true } }),
      db.project.findFirst({ where: { workspaceId: A.workspaceId, name: "Date probe" }, select: { targetDate: true, startDate: true } }),
      db.contact.findFirst({ where: { workspaceId: A.workspaceId, fullName: "Follow Up" }, select: { nextFollowUpAt: true } }),
    ]);

    assert.equal(rows[0]?.dueAt?.toISOString(), "2026-09-29T00:00:00.000Z");
    assert.equal(rows[1]?.targetDate?.toISOString(), "2026-09-29T00:00:00.000Z");
    assert.equal(rows[1]?.startDate?.toISOString(), "2026-01-01T00:00:00.000Z", "a new-year date drifted");
    assert.equal(rows[2]?.nextFollowUpAt?.toISOString(), "2026-09-29T00:00:00.000Z");
  });

  test("a date imported from a spreadsheet holds its day too", async () => {
    const { analyzeSpreadsheet, commitImport } = await import("../../src/lib/actions/import-batches");
    const { resetRateLimit } = await import("../../src/lib/rate-limit");
    await resetRateLimit("import", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });

    const csv = "RFP ID,Title,Deadline\nIMP-1,Imported deadline probe,2026-09-29\n";
    const previewed = await asOwner(() =>
      analyzeSpreadsheet({ workspaceId: A.workspaceId, fileName: "d.csv", content: csv }),
    );
    assert.equal(previewed.ok, true, JSON.stringify(previewed));
    if (!previewed.ok) return;

    await resetRateLimit("import", { user: A.ownerId, workspace: A.workspaceId, global: A.ownerId });
    const committed = await asOwner(() =>
      commitImport({ workspaceId: A.workspaceId, batchId: previewed.data.batchId }),
    );
    assert.equal(committed.ok, true, JSON.stringify(committed));

    const row = await db.opportunity.findFirst({
      where: { workspaceId: A.workspaceId, solicitationNumber: "IMP-1" },
      select: { proposalDeadlineAt: true },
    });
    assert.equal(
      row?.proposalDeadlineAt?.toISOString(),
      "2026-09-29T00:00:00.000Z",
      "the imported deadline is not the day the file said",
    );
    for (const tz of ZONES) {
      assert.equal(prefillIn(tz, row!.proposalDeadlineAt!.toISOString()), "2026-09-29", `${tz} shifted it`);
    }
  });

  test("a real timestamp is still an instant, not a day", async () => {
    // Guards the other direction: nothing here may flatten createdAt.
    const row = await db.opportunity.findFirst({
      where: { workspaceId: A.workspaceId },
      select: { createdAt: true },
    });
    assert.ok(row?.createdAt);
    const iso = row!.createdAt.toISOString();
    assert.notEqual(iso.slice(11), "00:00:00.000Z", "createdAt was truncated to a calendar day");
  });
});
