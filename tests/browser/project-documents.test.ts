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

const world = { ownerEmail: "", viewerEmail: "", projectId: "", workspaceId: "" };

/** `%PDF-1.7` and filler. Accepted. */
const GOOD = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31, 0x20, 0x30,
]);
/**
 * A genuinely valid single-page PDF, with a real xref table.
 *
 * `GOOD` above is eighteen bytes of `%PDF` header and filler: enough to satisfy
 * the server's magic-byte check, which is all the upload tests need. It is not
 * a document, and PDF.js correctly refuses it with "Invalid PDF structure" —
 * which is how this test first failed, on a viewer that was working properly.
 */
function validPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 14 Tf 24 60 Td (viewer test) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

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

  // A second account, purely so the viewer block has sign-ins of its own.
  // `loginPerAccount` allows five per account per fifteen minutes and the
  // suites above spend all five; a sixth is refused, and surfaces as a sign-in
  // that never completes. The limit is a real control, so the tests work
  // within it rather than around it.
  const viewerUser = await db.user.create({
    data: {
      email: `documents-viewer-${randomUUID().slice(0, 8)}@render.test`.toLowerCase(),
      name: "Documents Viewer",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  users.push(viewerUser.id);
  world.viewerEmail = viewerUser.email;
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: viewerUser.id, role: "admin" },
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

describe("the document viewer", { concurrency: false }, () => {
  /**
   * The viewer renders the file itself — PDF.js onto a canvas — rather than
   * handing it to the browser as a document. So these assert that a canvas
   * appears and reports pages, not that an iframe loaded: an iframe appearing
   * here would mean the CSP had been relaxed and the architecture abandoned.
   *
   * One page, signed in once, shared by the three tests. Not a style choice:
   * `loginPerAccount` allows five sign-ins per account per fifteen minutes and
   * the suite above already spends five. A sixth returns a rate-limit refusal,
   * which surfaces here as a sign-in that never completes. Sharing the session
   * is the honest fix — raising the limit for tests would be weakening a real
   * control to accommodate the harness.
   */
  let page: Page;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];

  before(async () => {
    if (!configured) return;
    page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url().split("?")[0]} — ${request.failure()?.errorText}`);
    });
    await signIn(page, world.viewerEmail);
    await openProject(page);

    // Two documents, uploaded once: one the viewer can render, one it cannot.
    await page.setInputFiles('input[type="file"]', [
      { name: "viewer-check.pdf", mimeType: "application/pdf", buffer: validPdf() },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain text, deliberately unrendered") },
    ]);
    await page.waitForSelector("text=viewer-check.pdf", { timeout: 60_000 });
    await page.waitForTimeout(2500); // the list refreshes after confirm
  });

  after(async () => {
    await page?.close();
  });

  /** Leaves no modal open, so one failure does not cascade into the rest. */
  async function closeAnyDialog() {
    if ((await page.locator('[role="dialog"]').count()) > 0) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  test("clicking the filename opens a viewer that renders the PDF", needsStorage, async () => {
    try {
    await page.getByRole("button", { name: "View viewer-check.pdf" }).click();
    // Scoped by accessible name: under `next dev` the error overlay is also a
    // role="dialog", so a bare selector matches two elements.
    const dialog = page.getByRole("dialog", { name: /viewer-check\.pdf/ });
    await dialog.waitFor({ timeout: 30_000 });

    // Surfaced first, because a console error here is the signal that matters
    // and everything below would otherwise fail with a less useful message.
    assert.deepEqual(
      consoleErrors.filter((e) => !/favicon|DevTools/i.test(e)),
      [],
      `console errors while viewing: ${consoleErrors.join(" | ")}`,
    );

    // PDF.js has painted, and knows how long the document is.
    // Wait for whichever arrives first: a painted canvas, or the error state.
    // Waiting only for the canvas turns any render failure into a bare timeout
    // that says nothing about why.
    try {
      await page.waitForFunction(
        () => {
          const d = [...document.querySelectorAll('[role="dialog"]')]
            .find((el) => (el.textContent ?? "").includes("viewer-check.pdf"));
          if (!d) return false;
          return Boolean(d.querySelector("canvas")) || /could not be displayed/.test(d.textContent ?? "");
        },
        undefined,
        { timeout: 60_000 },
      );
    } catch {
      assert.fail(
        "the viewer never rendered and never errored. " +
          `dialog=${((await dialog.textContent()) ?? "").replace(/\s+/g, " ").slice(0, 200)} | ` +
          `pageErrors=${JSON.stringify(pageErrors)} | ` +
          `consoleErrors=${JSON.stringify(consoleErrors.slice(0, 5))} | ` +
          `failedRequests=${JSON.stringify(failedRequests.slice(0, 5))}`,
      );
    }
    const shown = (await dialog.textContent()) ?? "";
    assert.ok(
      !/could not be displayed/.test(shown),
      `the viewer failed to render the PDF: ${shown.replace(/\s+/g, " ").slice(0, 300)}`,
    );
    await dialog.locator("canvas").waitFor({ timeout: 60_000 });
    try {
      await page.waitForFunction(
        () => {
          const d = [...document.querySelectorAll('[role="dialog"]')]
            .find((el) => (el.textContent ?? "").includes("viewer-check.pdf"));
          return /(^|\D)1\s*\/\s*1(\D|$)/.test(d?.textContent ?? "");
        },
        undefined,
        { timeout: 45_000 },
      );
    } catch {
      // The canvas element always exists, so reaching here means PDF.js never
      // reported a page count — the document did not open.
      assert.fail(
        "PDF.js never reported a page count. " +
          `dialog=${((await dialog.textContent()) ?? "").replace(/\s+/g, " ").slice(0, 200)} | ` +
          `pageErrors=${JSON.stringify(pageErrors.slice(0, 3))} | ` +
          `consoleErrors=${JSON.stringify(consoleErrors.slice(0, 5))} | ` +
          `failedRequests=${JSON.stringify(failedRequests.slice(0, 5))}`,
      );
    }

    const size = await dialog.locator("canvas").evaluate((c) => ({
      w: (c as HTMLCanvasElement).width,
      h: (c as HTMLCanvasElement).height,
    }));
    assert.ok(size.w > 0 && size.h > 0, `the canvas was never sized: ${JSON.stringify(size)}`);

    // The architecture, asserted rather than assumed.
    assert.equal(
      await dialog.locator("iframe, embed, object").count(),
      0,
      "the viewer used an iframe/embed/object — the CSP architecture has been abandoned",
    );

    assert.equal(
      await dialog.getByRole("link", { name: /Download/ }).count(),
      1,
      "the viewer offers no download fallback",
    );

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 15_000 });
    } finally {
      await closeAnyDialog();
    }
  });

  test("Escape closes the viewer", needsStorage, async () => {
    await page.getByRole("button", { name: "View viewer-check.pdf" }).click();
    const dialog = page.getByRole("dialog", { name: /viewer-check\.pdf/ });
    await dialog.waitFor({ timeout: 30_000 });

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(await dialog.count(), 0, "Escape did not close the viewer");
  });

  test("a type with no renderer offers metadata and a download", needsStorage, async () => {
    await page.getByRole("button", { name: "View notes.txt" }).click();
    const dialog = page.getByRole("dialog", { name: /notes\.txt/ });
    await dialog.waitFor({ timeout: 30_000 });

    await page.waitForFunction(
      () => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find((el) => (el.textContent ?? "").includes("notes.txt"));
        return /No preview for this file type/.test(d?.textContent ?? "");
      },
      undefined,
      { timeout: 30_000 },
    );
    // Two is correct, not a bug: the body offers one and the footer keeps its
    // own. The claim is that a download is reachable, not that it is unique.
    assert.ok(
      (await dialog.getByRole("link", { name: /Download/ }).count()) >= 1,
      "an unrenderable type offered no download",
    );

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 15_000 });
  });
});
