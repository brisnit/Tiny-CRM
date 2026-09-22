import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

import { db } from "../helpers/fixtures";

/**
 * Documents on a project, in a real browser.
 *
 * Three things here cannot be tested anywhere else, because they only exist
 * once a browser is driving:
 *
 *   - a multi-file selection where one file succeeds and another does not. The
 *     server tests prove each outcome separately; only the UI has to hold both
 *     at once and still say something true.
 *   - retrying the failure without disturbing the success. A retry that
 *     re-uploaded the whole batch would duplicate the file that already worked,
 *     and nothing below the UI would notice.
 *   - the feature flag deciding whether the panel exists at all.
 *
 * The failing file is a real rejection rather than a simulated one: it is named
 * `.pdf` and contains HTML, so the server's magic-byte check refuses it. That
 * is the same defence proven in tests/security; here it is being used to
 * produce an honest partial failure.
 *
 * Needs an object store. Without one there is no upload to observe, so the
 * suite skips rather than passing vacuously.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const PASSWORD = "a-long-enough-password-5821";

const configured = Boolean(process.env.S3_ENDPOINT);
const needsStorage = configured
  ? undefined
  : { skip: "no S3_ENDPOINT; run scripts/minio.mjs start" };

let browser: Browser;
const users: string[] = [];
const workspaces: string[] = [];

const world = { ownerEmail: "", projectId: "", workspaceId: "" };

/** `%PDF-1.7` and filler. Accepted. */
const GOOD = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31, 0x20, 0x30,
]);
/** Named `.pdf`, actually HTML. Refused, by the control that exists to refuse it. */
const BAD = Buffer.from("<html><body>not a pdf at all</body></html>", "utf8");

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function openProject(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/projects/${world.projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(750); // hydration, before any click lands
}

before(async () => {
  if (!configured) {
    console.log("  (project documents browser suite skipped: no S3_ENDPOINT)");
    return;
  }

  browser = await chromium.launch();

  const email = `documents-owner-${randomUUID().slice(0, 8)}@render.test`.toLowerCase();
  const owner = await db.user.create({
    data: {
      email,
      name: "Documents Owner",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  users.push(owner.id);
  world.ownerEmail = owner.email;

  const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
  const workspace = await provisionWorkspace(owner.id, { name: "Documents Browser" });
  workspaces.push(workspace.id);
  world.workspaceId = workspace.id;

  const status = await db.projectStatus.findFirst({
    where: { workspaceId: workspace.id },
    select: { id: true },
  });
  const project = await db.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Documented Project",
      statusId: status!.id,
      ownerId: owner.id,
    },
    select: { id: true },
  });
  world.projectId = project.id;

  // The flag defaults to off, so the panel would not exist at all without this.
  await db.featureFlag.create({
    data: { key: "files", enabled: true, workspaceId: workspace.id },
  });
});

after(async () => {
  await browser?.close();
  for (const id of workspaces) await db.workspace.deleteMany({ where: { id } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("project documents", { concurrency: false }, () => {
  test("the panel offers an empty state before anything is attached", needsStorage, async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.ownerEmail);
      await openProject(page);

      const body = (await page.textContent("body")) ?? "";
      assert.ok(body.includes("Documents"), "the Documents panel was not rendered");
      assert.ok(body.includes("No documents yet"), "the empty state was not shown");
      assert.ok(body.includes("Add documents"), "the upload control was not shown");
    } finally {
      await page.close();
    }
  });

  test("one file succeeds, another fails, and it says so", needsStorage, async () => {
    const page = await browser.newPage();
    // An upload that fails inside the browser reports one sentence to the user.
    // The reason lives here, and without it a failure in this test is a guess.
    const networkFailures: string[] = [];
    page.on("requestfailed", (request) => {
      networkFailures.push(`${request.method()} ${request.url().split("?")[0]} — ${request.failure()?.errorText}`);
    });

    try {
      await signIn(page, world.ownerEmail);
      await openProject(page);

      await page.setInputFiles('input[type="file"]', [
        { name: "good-proposal.pdf", mimeType: "application/pdf", buffer: GOOD },
        { name: "bad-proposal.pdf", mimeType: "application/pdf", buffer: BAD },
      ]);

      // The batch has settled once the failure offers a retry.
      await page.waitForSelector("text=Retry", { timeout: 60_000 });
      await page.waitForSelector("text=good-proposal.pdf", { timeout: 60_000 });

      assert.equal(
        await page.locator("text=good-proposal.pdf").count(),
        1,
        "the successful document is not listed exactly once",
      );
      assert.equal(
        await page.locator("text=bad-proposal.pdf").count(),
        1,
        "the failed upload is not shown exactly once",
      );

      // The failure explains itself rather than vanishing.
      const body = (await page.textContent("body")) ?? "";
      assert.match(
        body,
        /do not match its extension|not accepted/,
        "the failed upload gave no reason",
      );

      // Ground truth: exactly one row exists, and it is the good one.
      const rows = await db.fileAsset.findMany({
        where: { projectId: world.projectId },
        select: { name: true },
      });
      assert.deepEqual(
        rows.map((r) => r.name),
        ["good-proposal.pdf"],
        // A filename on screen can be a queue row as easily as a stored
        // document, so a failure here needs the reason the upload gave.
        `on-page errors: ${JSON.stringify(await page.locator("li .text-rose-600, li .text-rose-400").allTextContents())}` +
          ` | network failures: ${JSON.stringify(networkFailures)}`,
      );
    } finally {
      await page.close();
    }
  });

  test("retrying the failure does not duplicate the file that worked", needsStorage, async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.ownerEmail);
      await openProject(page);

      // The good document is already there from the previous test.
      await page.waitForSelector("text=good-proposal.pdf", { timeout: 60_000 });

      await page.setInputFiles('input[type="file"]', [
        { name: "bad-again.pdf", mimeType: "application/pdf", buffer: BAD },
      ]);
      await page.waitForSelector("text=Retry", { timeout: 60_000 });

      await page.getByRole("button", { name: "Retry" }).first().click();
      await page.waitForTimeout(2500); // the retry runs and fails again

      // The retry re-ran only the file that failed.
      assert.equal(
        await page.locator("text=good-proposal.pdf").count(),
        1,
        "retrying duplicated the document that had already succeeded",
      );

      const rows = await db.fileAsset.findMany({
        where: { projectId: world.projectId },
        select: { name: true },
      });
      assert.deepEqual(
        rows.map((r) => r.name),
        ["good-proposal.pdf"],
        "a retry created rows it should not have",
      );
    } finally {
      await page.close();
    }
  });

  test("a stored document offers a download", needsStorage, async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.ownerEmail);
      await openProject(page);
      await page.waitForSelector("text=good-proposal.pdf", { timeout: 60_000 });

      const download = page.getByRole("link", { name: "Download good-proposal.pdf" });
      assert.equal(await download.count(), 1, "no download control for the document");
      assert.match(
        (await download.getAttribute("href")) ?? "",
        /^\/api\/files\/[^/]+\/download$/,
        "the download does not point at the authorised route",
      );
    } finally {
      await page.close();
    }
  });

  test("with the flag off the panel does not exist", needsStorage, async () => {
    await db.featureFlag.updateMany({
      where: { key: "files", workspaceId: world.workspaceId },
      data: { enabled: false },
    });

    const page = await browser.newPage();
    try {
      await signIn(page, world.ownerEmail);
      await openProject(page);

      const body = (await page.textContent("body")) ?? "";
      assert.ok(!body.includes("Add documents"), "the upload control survived the flag being off");
      assert.ok(
        !body.includes("good-proposal.pdf"),
        "documents were still listed with the flag off",
      );
    } finally {
      await page.close();
      await db.featureFlag.updateMany({
        where: { key: "files", workspaceId: world.workspaceId },
        data: { enabled: true },
      });
    }
  });
});
