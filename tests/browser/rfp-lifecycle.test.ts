import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Locator, type Page } from "playwright";

import { db } from "../helpers/fixtures";

/**
 * The false overdue, in a real browser.
 *
 * This is the case the whole RFP lifecycle exists for: a proposal submitted on
 * time, whose deadline then passes, and which Tiny went on calling "1 day
 * overdue" — on the opportunity, and on the project carrying the same date.
 *
 * It is a browser test because the defect was never in one place. The data said
 * one thing, the card said another, and the project card said a third; only
 * walking the screens the way a person does shows whether they now agree.
 *
 * The dates are deliberate: the deadline is yesterday and the submission is
 * yesterday too, so the proposal was on time and nothing here should read as
 * late. Both stored dates must survive — this changes what they mean, not what
 * they are.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const PASSWORD = "a-long-enough-password-7741";

let browser: Browser;
const users: string[] = [];

/** Local noon N days from today, so a date-only comparison never lands on a boundary. */
function day(offset: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(12, 0, 0, 0);
  return date;
}

/** The value a date input expects. */
function inputValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/**
 * An owner with a project whose target date is an RFP's proposal deadline —
 * the shape the same-calendar-day rule is about.
 */
async function ownerWithRfp(label: string, options: { submitted?: boolean } = {}) {
  const email = `rfp-${label}-${randomUUID().slice(0, 8)}@rfp.test`.toLowerCase();
  const user = await db.user.create({
    data: {
      email,
      name: `${label} Owner`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true },
  });
  users.push(user.id);

  const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
  const workspace = await provisionWorkspace(user.id, { name: `${label} Studio` });

  const deadline = day(-1);
  const status = await db.projectStatus.findFirst({
    where: { workspaceId: workspace.id, isTerminal: false },
    select: { id: true },
  });
  const project = await db.project.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Authority Website`,
      targetDate: deadline,
      statusId: status?.id ?? null,
      lastActivityAt: new Date(),
    },
    select: { id: true },
  });
  const opportunity = await db.opportunity.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Authority RFP`,
      projectId: project.id,
      proposalDeadlineAt: deadline,
      deadlineAt: deadline,
      ...(options.submitted ? { submissionStatus: "submitted" } : {}),
    },
    select: { id: true },
  });

  return { email, workspaceId: workspace.id, projectId: project.id, opportunityId: opportunity.id, deadline };
}

/**
 * Waits for the stored row, not the words on screen.
 *
 * Screen text is how this test first passed a flow that did nothing: "Submitted"
 * was the dialog's own title. The record is the only witness worth asking.
 */
async function waitForRow(
  page: Page,
  id: string,
  matches: (row: {
    submissionStatus: string;
    submittedAt: Date | null;
    decisionExpectedAt: Date | null;
  }) => boolean,
): Promise<void> {
  let row: {
    submissionStatus: string;
    submittedAt: Date | null;
    decisionExpectedAt: Date | null;
  } | null = null;
  for (let attempt = 0; attempt < 90; attempt++) {
    row = await db.opportunity.findFirst({
      where: { id },
      select: { submissionStatus: true, submittedAt: true, decisionExpectedAt: true },
    });
    if (row && matches(row)) return;
    await page.waitForTimeout(500);
  }
  const toast = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
  assert.fail(
    `the stored row never matched. row: ${JSON.stringify(row)} · toast: ${toast.join(" | ") || "none"}`,
  );
}

/**
 * Polls a view until its text matches.
 *
 * The stored row changes before the screen does — the save resolves, then the
 * router refreshes — so reading the page once, straight after the write lands,
 * asks the question too early and gets the old answer.
 */
async function waitForText(
  read: () => Promise<string>,
  pattern: RegExp,
  message: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await read();
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) assert.fail(`${message}\nwhat the page said:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Update status → Decision expected…, edit, save. */
async function setExpectedDecision(
  page: Page,
  edit: (dialog: Locator) => Promise<void>,
): Promise<void> {
  await page.getByRole("button", { name: /Update status/i }).first().click();
  await page.getByRole("menuitem", { name: /Decision expected/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 30_000 });
  await edit(dialog);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
}

describe("an RFP submitted on time stops reading as overdue", () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    if (users.length > 0) {
      await db.workspaceMember.deleteMany({ where: { userId: { in: users } } });
      await db.workspace.deleteMany({ where: { ownerId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
    await db.$disconnect();
  });

  test("the whole visible transition, from overdue to awaiting a decision", async () => {
    const host = await ownerWithRfp("Water");
    const page = await browser.newPage();
    await signIn(page, host.email);

    // --- Before: both surfaces call it overdue --------------------------------
    await page.goto(`${BASE_URL}/opportunities`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByText("Water Authority RFP", { exact: false }).first().waitFor({ timeout: 60_000 });
    assert.match(
      await page.locator("body").innerText(),
      /overdue/i,
      "the opportunity list did not show the passed deadline as overdue",
    );

    await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByText("Water Authority Website", { exact: false }).first().waitFor({ timeout: 60_000 });
    const projectsBefore = await page.locator("body").innerText();
    assert.match(projectsBefore, /overdue/i, "the project card did not show the passed target date as overdue");
    assert.match(projectsBefore, /At risk/i, "the project was not at risk before submission");

    // --- Mark it submitted, on the day it was actually due ---------------------
    await page.goto(`${BASE_URL}/opportunities/${host.opportunityId}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    // Before hydration the button is inert markup and the click does nothing —
    // silently, so the only symptom is a dialog that never opens. A cold CI
    // runner can be many seconds behind the HTML, and a fixed pause is a guess
    // about a machine we do not control, so ask for the dialog until it comes.
    const markSubmitted = page.getByRole("button", { name: "Mark submitted", exact: true }).first();
    await markSubmitted.waitFor({ timeout: 60_000 });
    const dialog = page.getByRole("dialog");
    for (let attempt = 0; attempt < 8 && !(await dialog.isVisible()); attempt++) {
      await markSubmitted.click({ timeout: 15_000 }).catch(() => {});
      await dialog.waitFor({ timeout: 15_000 }).catch(() => {});
    }
    await dialog.waitFor({ timeout: 30_000 });
    await dialog.locator('input[type="date"]').first().fill(inputValue(host.deadline));
    await dialog.getByRole("button", { name: "Mark submitted", exact: true }).click();

    // The record itself, not the words on screen. "Submitted" appears in the
    // dialog's own title, so waiting for that text passes whether or not
    // anything saved — which is exactly how this test first passed a flow that
    // did nothing.
    let saved: { submissionStatus: string; submittedAt: Date | null } | null = null;
    for (let attempt = 0; attempt < 90; attempt++) {
      saved = await db.opportunity.findFirst({
        where: { id: host.opportunityId },
        select: { submissionStatus: true, submittedAt: true },
      });
      if (saved?.submissionStatus === "submitted") break;
      await page.waitForTimeout(500);
    }
    const toast = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    assert.equal(
      saved?.submissionStatus,
      "submitted",
      `the action did not save. toast: ${toast.join(" | ") || "none"}`,
    );
    assert.ok(saved?.submittedAt, "no submission date was stored");

    // The stored deadline is still on the record: history, not an obligation.
    const detail = await waitForText(
      () => page.locator("body").innerText(),
      /Submitted/i,
      "the detail page does not say it was submitted",
    );
    assert.match(detail, /Proposal due/i, "the proposal deadline disappeared from the record");

    // --- After: the opportunity ----------------------------------------------
    await page.goto(`${BASE_URL}/opportunities`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByText("Water Authority RFP", { exact: false }).first().waitFor({ timeout: 60_000 });
    const oppAfter = await page.locator("body").innerText();
    assert.match(oppAfter, /Submitted/i, "the card does not say the proposal is in");
    assert.match(oppAfter, /Awaiting decision/i, "the card does not say what it is waiting for");
    assert.doesNotMatch(oppAfter, /overdue/i, "the card still calls a submitted proposal overdue");
    assert.doesNotMatch(oppAfter, /days? after the deadline/i, "an on-time submission was reported as late");

    // --- After: the project it belongs to ------------------------------------
    await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByText("Water Authority Website", { exact: false }).first().waitFor({ timeout: 60_000 });
    const projectAfter = await page.locator("body").innerText();
    assert.doesNotMatch(projectAfter, /overdue/i, "the project still treats a met target date as overdue");
    assert.match(projectAfter, /Submitted/i, "the project card does not follow the RFP");
    assert.match(projectAfter, /On track/i, "the project is still at risk after meeting its date");

    await page.close();
  });

  test("unknown is a choice at submission, and can be changed afterwards", async () => {
    const host = await ownerWithRfp("Unknown");
    const page = await browser.newPage();
    await signIn(page, host.email);

    await page.goto(`${BASE_URL}/opportunities/${host.opportunityId}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    const markSubmitted = page.getByRole("button", { name: "Mark submitted", exact: true }).first();
    await markSubmitted.waitFor({ timeout: 60_000 });
    const dialog = page.getByRole("dialog");
    for (let attempt = 0; attempt < 8 && !(await dialog.isVisible()); attempt++) {
      await markSubmitted.click({ timeout: 15_000 }).catch(() => {});
      await dialog.waitFor({ timeout: 15_000 }).catch(() => {});
    }
    await dialog.waitFor({ timeout: 30_000 });

    // The hint says the submission date defaults to today, so it had better.
    // It read "" for a while, which left the field blank and the button dead.
    assert.equal(
      await dialog.locator('input[type="date"]').first().inputValue(),
      inputValue(day(0)),
      "the submitted date did not default to today",
    );

    // Unknown is offered as an answer, and is the one already selected.
    const unknown = dialog.getByRole("radio", { name: "Unknown" });
    await unknown.waitFor({ timeout: 15_000 });
    assert.equal(await unknown.isChecked(), true, "Unknown was not the default answer");

    await dialog.getByRole("button", { name: "Mark submitted", exact: true }).click();
    await waitForRow(page, host.opportunityId, (row) => row.submissionStatus === "submitted");
    const stored = await db.opportunity.findFirst({
      where: { id: host.opportunityId },
      select: { decisionExpectedAt: true },
    });
    assert.equal(stored?.decisionExpectedAt, null, "choosing Unknown invented a date");

    // The record says it plainly rather than leaving the question unanswered.
    await waitForText(
      () => page.locator("body").innerText(),
      /Not known yet/i,
      "the detail page hid the unknown decision date",
    );

    // And the card, where the waiting is the whole story.
    const card = async () => {
      await page.goto(`${BASE_URL}/opportunities`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.getByText("Unknown Authority RFP", { exact: false }).first().waitFor({ timeout: 60_000 });
      return page.locator("body").innerText();
    };
    const awaiting = await waitForText(
      card,
      /Awaiting decision/i,
      "an unknown decision date did not read as awaiting",
    );
    assert.match(awaiting, /Submitted/i, "the card does not say the proposal is in");
    assert.doesNotMatch(awaiting, /overdue/i, "an unknown decision date produced an overdue state");

    // Unknown -> a date.
    const detailUrl = `${BASE_URL}/opportunities/${host.opportunityId}`;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await setExpectedDecision(page, async (body) => {
      await body.getByRole("radio", { name: "On a date" }).check();
      await body.getByLabel("Expected decision date").fill(inputValue(day(30)));
    });
    await waitForRow(page, host.opportunityId, (row) => row.decisionExpectedAt !== null);
    await waitForText(card, /Decision expected/i, "a known decision date never reached the card");

    // ...and back to Unknown again, which is the direction that tends to be
    // impossible: a date you can add but never take away is not an answer.
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await setExpectedDecision(page, async (body) => {
      await body.getByRole("radio", { name: "Unknown" }).check();
    });
    await waitForRow(page, host.opportunityId, (row) => row.decisionExpectedAt === null);

    const ended = await waitForText(
      card,
      /Awaiting decision/i,
      "returning to unknown lost the awaiting state",
    );
    assert.doesNotMatch(ended, /overdue/i, "returning to unknown produced an overdue state");

    await page.close();
  });

  test("an imported RFP submitted with no date says so, without inventing one", async () => {
    // The 22-row backlog: submissionStatus "submitted", submittedAt never captured.
    const host = await ownerWithRfp("Imported", { submitted: true });
    const page = await browser.newPage();
    await signIn(page, host.email);

    await page.goto(`${BASE_URL}/opportunities`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByText("Imported Authority RFP", { exact: false }).first().waitFor({ timeout: 60_000 });
    const text = await page.locator("body").innerText();

    assert.match(text, /Submitted/i, "an imported submitted RFP does not read as submitted");
    assert.match(text, /Awaiting decision/i, "it does not say what it is waiting for");
    assert.doesNotMatch(text, /overdue/i, "an imported submitted RFP is still called overdue");

    await page.close();
  });
});
