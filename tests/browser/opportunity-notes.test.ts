import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

import { db } from "../helpers/fixtures";

/**
 * Notes on an opportunity, in a real browser.
 *
 * The integration suite proves the rules. This proves the page: that the Notes
 * panel is there before any note exists, that a note written in it is a real
 * note and appears, and that editing and deleting — with Undo — work where a
 * person actually does them. The original defect lived entirely in the page:
 * the obvious button wrote something the list never showed, and the list hid
 * itself until something else filled it.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const PASSWORD = "a-long-enough-password-5821";

let browser: Browser;
const users: string[] = [];

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/** An owner, their workspace built the way production builds one, and an opportunity in it. */
async function ownerWithOpportunity(label: string) {
  const email = `notes-${label}-${randomUUID().slice(0, 8)}@notes.test`.toLowerCase();
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
  const opportunity = await db.opportunity.create({
    data: { workspaceId: workspace.id, name: `${label} Website Redesign RFP` },
    select: { id: true },
  });
  return { email, workspaceId: workspace.id, opportunityId: opportunity.id };
}

async function openOpportunity(page: Page, opportunityId: string) {
  await page.goto(`${BASE_URL}/opportunities/${opportunityId}`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.getByRole("heading", { name: "Notes", exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(750); // hydration
}

describe("notes on an opportunity, in a browser", () => {
  before(async () => {
    browser = await chromium.launch();

    // The harness warms this page with a real session before any suite runs
    // (tests/browser/support/warm-authenticated-routes.ts); this catches a run
    // where that warm-up failed. It cannot do more: the runner's --test-timeout
    // bounds this whole file, before() included.
    const warm = await browser.newPage();
    const host = await ownerWithOpportunity("Warmup");
    await signIn(warm, host.email);
    await warm
      .goto(`${BASE_URL}/opportunities/${host.opportunityId}`, {
        waitUntil: "domcontentloaded",
        timeout: 300_000,
      })
      .catch(() => {});
    await warm.close();
  });

  after(async () => {
    await browser?.close();
    if (users.length > 0) {
      await db.workspaceMember.deleteMany({ where: { userId: { in: users } } });
      // Cascades to the opportunities, notes and activities made here.
      await db.workspace.deleteMany({ where: { ownerId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
    await db.$disconnect();
  });

  test("the Notes panel is there before any note exists, and the timeline offers no second kind of note", async () => {
    const host = await ownerWithOpportunity("Empty");
    const page = await browser.newPage();
    await signIn(page, host.email);
    await openOpportunity(page, host.opportunityId);

    await page.getByText("No notes yet").waitFor({ timeout: 30_000 });
    assert.equal(
      await page.getByRole("button", { name: "Add note", exact: true }).count(),
      1,
      "the panel offers no way to add a note",
    );
    // The composer's Note pill is hidden on this page; the panel is the one place.
    assert.equal(
      await page.getByRole("button", { name: "Note", exact: true }).count(),
      0,
      "the timeline still offers a second, competing way to write a note",
    );
    await page.close();
  });

  test("a note written in the panel is a real note, appears, can be edited, and can be deleted and restored", async () => {
    const host = await ownerWithOpportunity("Journey");
    const page = await browser.newPage();
    await signIn(page, host.email);
    await openOpportunity(page, host.opportunityId);

    // Add.
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await page.getByLabel("Note title", { exact: true }).fill("Pre-bid call");
    await page.getByRole("textbox", { name: "Note text", exact: true }).click();
    await page.keyboard.type("They will accept WordPress or Drupal.");
    await page.getByRole("button", { name: "Save note", exact: true }).click();

    const row = page.getByRole("listitem", { name: "Pre-bid call", exact: true });
    await row.waitFor({ timeout: 30_000 });
    assert.match(await row.innerText(), /WordPress or Drupal/, "the note's text is not shown");

    const created = await db.note.findFirst({
      where: { opportunityId: host.opportunityId, title: "Pre-bid call" },
      select: { id: true, body: true, archivedAt: true },
    });
    assert.ok(created, "the panel did not create a Note record");
    assert.match(created.body, /WordPress or Drupal/);
    const entry = await db.activity.findFirst({ where: { noteId: created.id } });
    assert.ok(entry, "adding a note left no timeline history");

    // Edit.
    await row.getByRole("button", { name: "Edit note", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Note text", exact: true });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Budget is not stated.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("listitem", { name: "Pre-bid call", exact: true }).getByText(/Budget is not stated/).waitFor({
      timeout: 30_000,
    });
    const edited = await db.note.findUniqueOrThrow({ where: { id: created.id }, select: { body: true } });
    assert.match(edited.body, /Budget is not stated/, "the edit was not saved");

    // Delete, then Undo.
    await page.getByRole("listitem", { name: "Pre-bid call", exact: true }).getByRole("button", { name: "Delete note", exact: true }).click();
    await page.getByText("Note deleted").waitFor({ timeout: 30_000 });
    await page.getByRole("listitem", { name: "Pre-bid call", exact: true }).waitFor({ state: "detached", timeout: 30_000 });
    const trashed = await db.note.findUniqueOrThrow({ where: { id: created.id }, select: { archivedAt: true } });
    assert.ok(trashed.archivedAt, "Delete did not move the note to the Trash");

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("listitem", { name: "Pre-bid call", exact: true }).waitFor({ timeout: 30_000 });
    const restored = await db.note.findUniqueOrThrow({ where: { id: created.id }, select: { archivedAt: true } });
    assert.equal(restored.archivedAt, null, "Undo did not restore the note");

    await page.close();
  });
});
