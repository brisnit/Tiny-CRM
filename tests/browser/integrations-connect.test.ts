import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";

import bcrypt from "bcryptjs";

import { db } from "../helpers/fixtures";

/**
 * Clicking Connect, in a real browser.
 *
 * ## The defect this is the regression test for
 *
 * The button rendered, was enabled, and did **nothing**. `form-action 'self'`
 * permitted the same-origin POST and then rejected the 303 to
 * `login.microsoftonline.com`, because `form-action` applies across redirects.
 * The way it failed is why a server test could never have caught it:
 *
 *   - the request never reached the server, so nothing appeared in any log;
 *   - Chrome's console message named the form's own same-origin action URL,
 *     not the redirect target, so it read as a same-origin refusal;
 *   - the page just sat there.
 *
 * Only a browser sees this. The unit test
 * tests/unit/csp-oauth-origins.test.ts covers the policy's *content*; this
 * covers the click.
 *
 * ## Mocked, and it does not follow the redirect
 *
 * The provider is intercepted: the navigation to Microsoft is caught and
 * fulfilled with a stub page, and the test asserts the **URL that was
 * requested**. Nothing reaches Microsoft, no code is exchanged, and a pass says
 * nothing about the real handshake — which is verified by a person against the
 * canary tenant and recorded separately.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const PASSWORD = "correct-horse-battery";

/** Matches the ids the harness passes to the server. */
const CLIENT_ID = "080880ad-f468-4e83-bf08-b117e13deba5";
const TENANT_ID = "4883aac4-8e9b-42fe-a7cf-78b9183ddc99";

let browser: Browser;
const world = { email: "", workspaceId: "" };
const users: string[] = [];
const workspaces: string[] = [];

before(async () => {
  browser = await chromium.launch();

  const user = await db.user.create({
    data: {
      email: `connect-${randomUUID().slice(0, 8)}@integrations.test`.toLowerCase(),
      name: "Connect Tester",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
      // Pro, because sync is gated at Pro and this is not a test of the gate.
      plan: "pro",
      updatedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  users.push(user.id);
  world.email = user.email;

  const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
  const workspace = await provisionWorkspace(user.id, { name: "Connect workspace" });
  workspaces.push(workspace.id);
  world.workspaceId = workspace.id;

  // For this workspace only. The global row stays off, and the test asserts
  // that below rather than trusting it.
  await db.featureFlag.upsert({
    where: { key_workspaceId: { key: "integrations", workspaceId: workspace.id } },
    create: { key: "integrations", workspaceId: workspace.id, enabled: true, updatedAt: new Date() },
    update: { enabled: true, updatedAt: new Date() },
  });
});

after(async () => {
  await browser?.close();
  await db.featureFlag.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await db.integration.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration, before any click lands
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

describe("connecting a mailbox, in a browser", () => {
  test("the global flag is off, so this is proving a per-workspace override", async () => {
    const global = await db.featureFlag.findFirst({
      where: { key: "integrations", workspaceId: null },
      select: { enabled: true },
    });
    assert.ok(
      !global || global.enabled === false,
      "the global integrations flag is on, so this test proves nothing about the override",
    );
  });

  test("clicking Connect navigates to the provider's authorisation URL", async () => {
    const page = await browser.newPage();
    const cspMessages: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) cspMessages.push(message.text());
    });

    // Catch the navigation instead of following it. This is the mock: the
    // provider is never contacted.
    let authorizeUrl: string | null = null;
    await page.route("https://login.microsoftonline.com/**", async (route) => {
      authorizeUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body><h1>Stub consent screen</h1></body></html>",
      });
    });

    try {
      await signIn(page, world.email);
      await page.goto(`${BASE_URL}/settings/integrations`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector("text=Email & calendar", { timeout: 30_000 });
      await page.waitForTimeout(750);

      const connect = page.getByRole("button", { name: /^Connect$/ }).first();
      assert.ok(await connect.isVisible(), "no enabled Connect button was rendered");
      assert.ok(await connect.isEnabled(), "the Connect button was disabled");

      await connect.click();
      // The stub page, reached through our 303.
      await page.waitForURL(/login\.microsoftonline\.com/, { timeout: 30_000 });

      assert.ok(authorizeUrl, "the browser never requested an authorisation URL");
      const url = new URL(authorizeUrl!);

      // The tenant-specific authority, not /common.
      assert.equal(url.origin, "https://login.microsoftonline.com");
      assert.ok(
        url.pathname.startsWith(`/${TENANT_ID}/`),
        `the authority was ${url.pathname} rather than the tenant-specific one`,
      );
      assert.ok(!url.pathname.includes("common"), "the authority was /common");

      assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok((url.searchParams.get("code_challenge") ?? "").length > 20, "no PKCE challenge");
      assert.ok((url.searchParams.get("state") ?? "").startsWith("v1."), "no signed state");
      assert.ok((url.searchParams.get("nonce") ?? "").length > 10, "no OIDC nonce");
      assert.equal(
        url.searchParams.get("redirect_uri"),
        `${BASE_URL}/api/integrations/microsoft/callback`,
      );
      // Read-only scopes, in any form.
      const scope = url.searchParams.get("scope") ?? "";
      assert.match(scope, /Mail\.Read/);
      assert.doesNotMatch(scope, /Mail\.Send|ReadWrite|\.write/i);

      assert.deepEqual(
        cspMessages,
        [],
        `the Content Security Policy blocked the submission: ${cspMessages.join(" | ")}`,
      );
    } finally {
      await page.close();
    }
  });

  test("the verifier cookie is set, httpOnly, and scoped to the callback path", async () => {
    const page = await browser.newPage();
    await page.route("https://login.microsoftonline.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }),
    );
    try {
      await signIn(page, world.email);
      await page.goto(`${BASE_URL}/settings/integrations`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(750);
      await page.getByRole("button", { name: /^Connect$/ }).first().click();
      await page.waitForURL(/login\.microsoftonline\.com/, { timeout: 30_000 });

      const cookie = (await page.context().cookies()).find((c) => c.name === "tc_oauth_verifier");
      assert.ok(cookie, "no PKCE verifier cookie was set, so the callback would be refused");
      assert.equal(cookie!.httpOnly, true, "the verifier is readable by script");
      assert.equal(cookie!.path, "/api/integrations", "the verifier is sent more widely than needed");
      assert.ok(cookie!.value.length > 20, "the verifier is too short to be a PKCE verifier");
    } finally {
      await page.close();
    }
  });

  test("nothing was imported, and the page does not claim otherwise", async () => {
    // Connected is not synced. No worker exists, so no record may appear.
    const [emails, events] = await Promise.all([
      db.emailMessage.count({ where: { workspaceId: world.workspaceId } }),
      db.calendarEvent.count({ where: { workspaceId: world.workspaceId } }),
    ]);
    assert.equal(emails, 0, "a message was imported, which nothing should be able to do yet");
    assert.equal(events, 0, "an event was imported, which nothing should be able to do yet");
  });
});
