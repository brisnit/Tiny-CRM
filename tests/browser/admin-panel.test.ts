import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";

import bcrypt from "bcryptjs";

import { db } from "../helpers/fixtures";

/**
 * The admin panel, driven through a real browser.
 *
 * Two things only a browser can establish here. That the **link is not shown**
 * to an ordinary account — a server test can assert the flag, not what was
 * rendered. And that `/admin` answers an ordinary account the way a
 * non-existent page does, by navigating to it rather than by calling a
 * function that throws.
 *
 * The mutations themselves are covered far more thoroughly in
 * tests/security/admin-*.test.ts, including against PostgreSQL as the
 * restricted role. What is asserted here is reachability and the three-way
 * plan display, which is a rendering claim.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
// The fixture's own password. An earlier version overwrote `passwordHash`
// after `createTenant` and every sign-in failed with `credentialssignin`;
// using what the fixture already set is both simpler and one less thing that
// can silently drift from it.
const PASSWORD = "correct-horse-battery";

const world = { adminId: "", adminEmail: "", ordinaryEmail: "", customerId: "", customerEmail: "" };
const users: string[] = [];
const workspaces: string[] = [];
let browser: Browser;

/**
 * An account with a workspace, built the way the document-Q&A suite builds
 * one — which is the pattern known to sign in in this harness.
 *
 * Two earlier attempts failed here and both are worth recording. Creating a
 * bare `User` produced accounts with no workspace, so every sign-in landed on
 * onboarding and the app shell — the thing this suite is about — never
 * rendered. Switching to `createTenant` and overwriting its password hash
 * then failed every sign-in with `credentialssignin`. Provisioning explicitly
 * avoids both.
 */
async function makeAccount(label: string, plan = "free"): Promise<{ id: string; email: string }> {
  const user = await db.user.create({
    data: {
      email: `${label}-${randomUUID().slice(0, 8)}@admin.test`.toLowerCase(),
      name: `${label} person`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
      plan,
    },
    select: { id: true, email: true },
  });
  users.push(user.id);

  const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
  const workspace = await provisionWorkspace(user.id, { name: `${label} workspace` });
  workspaces.push(workspace.id);

  return user;
}

before(async () => {
  browser = await chromium.launch();

  const admin = await makeAccount("admin");
  world.adminId = admin.id;
  world.adminEmail = admin.email;
  await db.platformAdmin.create({ data: { userId: admin.id, note: "browser suite" } });

  const ordinary = await makeAccount("ordinary");
  world.ordinaryEmail = ordinary.email;

  // A Stripe-backed plan *and* a complimentary grant, so the three-way
  // display has something to distinguish.
  const customer = await makeAccount("customer", "plus");
  world.customerId = customer.id;
  world.customerEmail = customer.email;
  await db.user.update({
    where: { id: customer.id },
    data: { billingCustomerId: "cus_browsersuite", planStatus: "active" },
  });
  await db.planGrant.create({
    data: {
      userId: customer.id, plan: "pro",
      reason: "design partner for Q1", grantedById: admin.id,
    },
  });
});

after(async () => {
  await browser?.close();
  await db.planGrant.deleteMany({ where: { userId: { in: users } } });
  await db.platformAdmin.deleteMany({ where: { userId: { in: users } } });
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

/**
 * The visible text, with Next's RSC payload removed.
 *
 * `textContent("body")` includes the flight data in the inline scripts, which
 * contains the literal `"forbidden":"$undefined"` — so a naive assertion that
 * a page does not say "forbidden" matched the router's own serialisation and
 * failed on every page in the product.
 */
async function visibleText(page: Page): Promise<string> {
  // `document.body.innerText`, and nothing cleverer. `innerText` is defined as
  // the *rendered* text, so it already excludes `<script>` — which is the
  // whole problem being solved.
  //
  // The first version cloned the body, stripped scripts and read `innerText`
  // off the clone. A detached node has no layout, so `innerText` came back as
  // the empty string; `?? textContent` never fired because "" is not nullish,
  // and every assertion ran against nothing. The absence check passed, the
  // presence checks failed, and the suite looked like a product bug.
  return page.evaluate(() => document.body.innerText);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration, before any click lands
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

describe("the admin panel in a browser", () => {
  test("an ordinary account sees no Admin link and cannot open /admin", async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.ordinaryEmail);
      const shell = await visibleText(page);
      assert.ok(!/\bAdmin\b/.test(shell), "an ordinary account was offered an Admin link");

      await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const body = await visibleText(page);
      // "Not found", not "forbidden": the surface must not confirm it exists.
      assert.ok(!/Customers/i.test(body), "an ordinary account reached the customer directory");
      assert.doesNotMatch(body, /forbidden|not authori[sz]ed|admin only/i);
    } finally {
      await page.close();
    }
  });

  test("the admin sees the link, the directory, and can search", async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.adminEmail);
      assert.match(await visibleText(page), /\bAdmin\b/, "no Admin link for the admin");

      await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("text=Customers", { timeout: 30_000 });

      await page.fill('input[name="q"]', world.customerEmail);
      await page.getByRole("button", { name: "Search customers" }).click();
      await page.waitForSelector(`text=${world.customerEmail}`, { timeout: 30_000 });
    } finally {
      await page.close();
    }
  });

  test("the detail page shows paid, complimentary and effective as three things", async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.adminEmail);
      await page.goto(`${BASE_URL}/admin/customers/${world.customerId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector("text=Effective entitlement", { timeout: 30_000 });
      const body = await visibleText(page);

      // The distinction the requirement is about: what Stripe charges for,
      // what was given, and what actually applies — never merged into one.
      // "Paid" is claimed only where a live subscription is indicated: this
      // fixture has a purchasable plan, an active status and a customer id.
      assert.match(body, /Paid: Plus/i, "a live Stripe subscription is not shown as paid");
      assert.match(body, /Complimentary: Pro/i, "the grant is not shown distinctly");
      assert.match(body, /Effective: Pro/i, "the effective entitlement is not shown");
      assert.match(body, /design partner for Q1/i, "the grant's reason is not shown");

      // The page's own honest framing. The stronger "creates no Stripe
      // subscription, charges nothing" wording lives in the grant dialog,
      // where the decision is actually made, and is asserted there.
      assert.match(body, /only ever adds/i, "the page does not say a grant cannot reduce access");
      assert.match(body, /Charges, refunds, cancellation/i, "the page does not defer billing to Stripe");
      // Workspaces owned vs member of, kept apart.
      assert.match(body, /Workspaces owned/i);
      assert.match(body, /Member of/i);
    } finally {
      await page.close();
    }
  });

  test("the grant dialog states that nothing is charged", async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.adminEmail);
      await page.goto(`${BASE_URL}/admin/customers/${world.customerId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector("text=Effective entitlement", { timeout: 30_000 });
      await page.waitForTimeout(750); // hydration, before any click lands

      await page.getByRole("button", { name: /complimentary access/i }).first().click();
      await page.waitForSelector("text=complimentary access", { timeout: 15_000 });
      const dialog = await page.getByRole("dialog").textContent() ?? "";
      assert.match(dialog, /no Stripe subscription/i, "the dialog does not say nothing is charged");
      assert.match(dialog, /charges nothing/i);
      assert.match(dialog, /only ever adds|never reduce/i);
      await page.keyboard.press("Escape");
    } finally {
      await page.close();
    }
  });

  test("suspension asks for a reason before it will proceed", async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.adminEmail);
      await page.goto(`${BASE_URL}/admin/customers/${world.customerId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector("text=Effective entitlement", { timeout: 30_000 });
      await page.waitForTimeout(750); // hydration, before any click lands

      await page.getByRole("button", { name: /^Suspend$/ }).click();
      await page.waitForSelector("text=Suspend this account", { timeout: 15_000 });

      const dialog = page.getByRole("dialog");
      // The confirm button is unusable until a reason is given.
      const confirm = dialog.getByRole("button", { name: "Suspend account" });
      assert.equal(await confirm.isDisabled(), true, "suspension was offered with no reason");

      // And the dialog says what it does not do.
      const text = (await dialog.textContent()) ?? "";
      assert.match(text, /does not cancel/i, "the dialog does not say Stripe is untouched");
      assert.match(text, /refund/i);

      await page.keyboard.press("Escape");
      const after = await db.user.findUniqueOrThrow({
        where: { id: world.customerId },
        select: { deactivatedAt: true },
      });
      assert.equal(after.deactivatedAt, null, "opening a dialog suspended an account");
    } finally {
      await page.close();
    }
  });
});
