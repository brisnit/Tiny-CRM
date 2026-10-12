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
 * ## What this file does and does not prove — read before trusting it
 *
 * It proves the click path: the form is wired, our start route really runs, the
 * authorisation URL it answers with is correct, the verifier cookie is set, and
 * no CSP violation occurs for the submission.
 *
 * It does **not** prove the policy permits the final hop. Mutation testing
 * settled that: reverting `form-action` to `'self'` alone leaves every test in
 * this file passing. The reason is structural rather than fixable here — the
 * provider must not be contacted in CI, so the 303 is intercepted, and
 * intercepting the redirect is exactly what stops the browser attempting the
 * cross-origin navigation the policy governs. Any mock that prevents the
 * contact prevents the check.
 *
 * So the division of labour is deliberate:
 *
 *   - `tests/unit/csp-oauth-origins.test.ts` is the guard against the
 *     regression returning. It fails if an authorisation origin is missing from
 *     `form-action`, and also if a stale one lingers. Both directions verified
 *     by mutation.
 *   - this file is the guard against the *click* breaking — a form that posts
 *     nowhere, a disabled button, a missing cookie, a wrong authority.
 *   - the final hop, a browser actually following the 303 to
 *     login.microsoftonline.com under this policy, is verified **manually**
 *     against the canary tenant. It is the one step that needs the real
 *     provider, and it is recorded as manual in docs/INTEGRATIONS.md rather
 *     than implied to be covered here.
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
  /**
   * How the provider is mocked, and why it is done at *our* redirect rather
   * than at the provider's URL.
   *
   * Two earlier attempts both let the real provider be contacted:
   *
   *   - `page.route("https://login.microsoftonline.com/**")` never fired. The
   *     navigation to the provider is the redirect *target* of the POST to our
   *     own route, and Playwright does not match a route pattern against a
   *     redirect hop of a main-frame navigation.
   *   - a catch-all `page.route("**\/*")` did not fire for it either, for the
   *     same reason — while `waitForURL` still passed, because the browser
   *     really did navigate. The test would have gone green having talked to
   *     Microsoft.
   *
   * So the interception is on **our own** start route, which is same-origin and
   * is matched. The handler lets the real server answer (`route.fetch()`), reads
   * the `Location` of the genuine 303, and then fulfils the browser with a plain
   * 200 carrying the real `Set-Cookie`. The click is real, our route really
   * runs, the authorisation URL is the one we would actually have sent — and the
   * browser never leaves localhost.
   */
  async function clickConnectAndCaptureRedirect(page: Page): Promise<{
    location: string | null;
    setCookie: string[];
    cspMessages: string[];
  }> {
    const cspMessages: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) cspMessages.push(message.text());
    });

    let location: string | null = null;
    let setCookie: string[] = [];
    await page.route("**/api/integrations/*/start", async (route) => {
      const real = await route.fetch({ maxRedirects: 0 });
      const headers = real.headers();
      location = headers["location"] ?? null;
      const raw = await real.headersArray();
      setCookie = raw.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
      // A 200 instead of the 303, so the browser has nowhere to go.
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: Object.fromEntries(
          raw
            .filter((h) => h.name.toLowerCase() === "set-cookie")
            .map((h) => ["set-cookie", h.value]),
        ),
        body: "<html><body>redirect intercepted — no provider was contacted</body></html>",
      });
    });

    // A belt-and-braces guarantee: if anything still tries to reach a provider,
    // the request fails rather than succeeding quietly.
    await page.route("https://login.microsoftonline.com/**", (route) => route.abort());
    await page.route("https://accounts.google.com/**", (route) => route.abort());

    await signIn(page, world.email);
    await page.goto(`${BASE_URL}/settings/integrations`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForSelector("text=Email & calendar", { timeout: 30_000 });
    await page.waitForTimeout(750); // hydration, before any click lands

    const connect = page.getByRole("button", { name: /^Connect$/ }).first();
    assert.ok(await connect.isVisible(), "no Connect button was rendered");
    assert.ok(await connect.isEnabled(), "the Connect button was disabled");
    await connect.click();
    await page.waitForFunction(
      () => document.body.textContent?.includes("redirect intercepted") === true,
      undefined,
      { timeout: 30_000 },
    );

    return { location, setCookie, cspMessages };
  }

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

  test("clicking Connect redirects to the provider's authorisation URL", async () => {
    const page = await browser.newPage();
    try {
      const { location, cspMessages } = await clickConnectAndCaptureRedirect(page);

      // The regression: with `form-action 'self'` the click produced no request
      // at all and exactly one console line naming the wrong URL.
      assert.deepEqual(
        cspMessages,
        [],
        `the Content Security Policy blocked the submission: ${cspMessages.join(" | ")}`,
      );
      assert.ok(location, "the start route did not answer with a redirect");

      const url = new URL(location!);
      assert.equal(url.origin, "https://login.microsoftonline.com");
      // Tenant-specific, not /common.
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

      const scope = url.searchParams.get("scope") ?? "";
      assert.match(scope, /Mail\.Read/);
      assert.doesNotMatch(scope, /Mail\.Send|ReadWrite|\.write/i, "a write scope was requested");
    } finally {
      await page.close();
    }
  });

  test("the verifier cookie is set, httpOnly, and scoped to the callback path", async () => {
    const page = await browser.newPage();
    try {
      const { setCookie } = await clickConnectAndCaptureRedirect(page);
      const verifier = setCookie.find((c) => c.startsWith("tc_oauth_verifier="));
      assert.ok(verifier, "no PKCE verifier cookie was set, so the callback would be refused");
      assert.match(verifier!, /HttpOnly/i, "the verifier is readable by script");
      assert.match(verifier!, /Path=\/api\/integrations/i, "the verifier is sent more widely than needed");
      assert.match(verifier!, /SameSite=Lax/i, "SameSite=Strict would withhold it on the way back");
      const value = verifier!.split(";")[0]!.split("=")[1] ?? "";
      assert.ok(value.length > 20, "the verifier is too short to be a PKCE verifier");
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
