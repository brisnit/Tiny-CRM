import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { type Browser, type Page } from "playwright";

import { db } from "../helpers/fixtures";
import { markImported, runnerMark, tracedLaunch } from "./_trace";

/**
 * The password reset flow, in a real browser.
 *
 * This suite exists because two consecutive fixes to this form were reasoned
 * about rather than observed, and each one shipped the next regression:
 *
 *  1. The form submitted only through React's `onSubmit`. Chrome's "Use Strong
 *     Password" submits another way, so the browser posted to the page, got a
 *     200, and re-rendered an empty form with the token still unconsumed — an
 *     unbounded loop.
 *  2. The fix for that introduced a form action, which made React reset the
 *     uncontrolled form after every completed action including a failed one, so
 *     a "passwords do not match" answer wiped both fields.
 *  3. The fix for *that* made the inputs controlled, and React's input
 *     reconciliation — which compares its prop against the live DOM value —
 *     wrote the empty state back over Chrome's generated password the moment
 *     the action began.
 *
 * The discriminating detail in all three is that a password manager writes
 * straight to the DOM node and dispatches nothing React can see. Every test
 * here that fills a password does it that way. `fillLikeAPasswordManager` is
 * the whole point of the suite: a test that types into the field exercises a
 * different code path and would have passed against every one of the three
 * broken versions.
 *
 * No password or token value is ever printed. Assertions are on booleans and on
 * bcrypt comparisons, so a failure message cannot carry a credential.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";

// Stands in for a browser-generated password. Never logged, never asserted on
// by value — only compared.
const GENERATED = "Xr7-quiet-Harbor-4192";

let browser: Browser;
const users: string[] = [];

/** Creates an account and a live reset token, returning the raw token. */
async function accountWithResetToken(): Promise<{ userId: string; token: string }> {
  const userId = `b${randomUUID().replace(/-/g, "")}`;
  await db.user.create({
    data: {
      id: userId,
      email: `browser-reset-${userId}@test.local`,
      name: "Browser Probe",
      passwordHash: await bcrypt.hash("the-original-password", 4),
      emailVerifiedAt: new Date(),
    },
  });
  users.push(userId);

  const token = randomBytes(32).toString("base64url");
  await db.authToken.create({
    data: {
      userId,
      purpose: "password_reset",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  return { userId, token };
}

/**
 * Writes to the input the way Chrome's generated-password flow does: through
 * the native value setter, dispatching **no** events.
 *
 * React's `onChange` is delegated from a real `input` event, so a component
 * that mirrors this field into state never learns the value exists. That is
 * precisely the condition under which a controlled input overwrites it, and
 * precisely what `page.fill()` would hide by dispatching events.
 */
async function fillLikeAPasswordManager(page: Page, selector: string, value: string) {
  await page.evaluate(
    ({ selector, value }) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(element, value);
    },
    { selector, value },
  );
}

/** True when the field still holds exactly what was written to it. */
async function stillHolds(page: Page, selector: string, value: string): Promise<boolean> {
  return page.evaluate(
    ({ selector, value }) => (document.querySelector(selector) as HTMLInputElement | null)?.value === value,
    { selector, value },
  );
}

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

/** Waits for React to hydrate, so the form action is actually wired up. */
async function hydrated(page: Page) {
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[type="submit"]');
    return Boolean(button && !button.hasAttribute("disabled"));
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(750);
}

markImported("password-reset");

describe("password reset, driven by a browser", () => {
  before(async () => {
    runnerMark("before:start", { suite: "password-reset" });
    browser = await tracedLaunch("password-reset");
    runnerMark("before:end", { suite: "password-reset" });
  });

  after(async () => {
    await browser?.close();
    await db.authToken.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  /**
   * THE REGRESSION TEST.
   *
   * This is the one that fails against the controlled-input implementation.
   * Verified by reverting the component to controlled inputs and re-running:
   * the field reads empty at the `pending` render and the assertion below
   * fires. Nothing else in this suite distinguishes the two implementations,
   * because the submitted FormData is captured before the clobbering render —
   * the reset still *completes*; it is the person watching the form empty
   * itself who gives up and starts the loop again.
   */
  test("a password-manager fill survives the render the submission causes", async () => {
    const { token } = await accountWithResetToken();
    const page = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(page);

    await fillLikeAPasswordManager(page, "#password", GENERATED);
    assert.ok(await stillHolds(page, "#password", GENERATED), "the fill did not land");

    // Submitting is what re-renders the component: `pending` flips to true.
    await page.click('button[type="submit"]');

    // Sample across the pending window rather than at one instant, so this
    // cannot pass by landing between the render and the response.
    for (let i = 0; i < 12; i++) {
      const gone = await page.evaluate(() => !document.querySelector("#password"));
      if (gone) break; // Replaced by the success panel, which is the good end.
      assert.ok(
        await stillHolds(page, "#password", GENERATED),
        "the field was emptied while the action was in flight — React overwrote a password-manager fill",
      );
      await page.waitForTimeout(100);
    }

    await page.waitForSelector("text=Your password is changed", { timeout: 30_000 });
    await page.close();
  });

  test("the server receives the generated password, and the reset completes", async () => {
    const { userId, token } = await accountWithResetToken();
    const page = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(page);

    await fillLikeAPasswordManager(page, "#password", GENERATED);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=Your password is changed", { timeout: 30_000 });

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    assert.ok(
      await bcrypt.compare(GENERATED, user.passwordHash!),
      "the stored hash does not match what the browser submitted",
    );
    assert.ok(user.passwordChangedAt, "passwordChangedAt was not stamped");
    await page.close();
  });

  test("the reset token is consumed, and cannot be used a second time", async () => {
    const { userId, token } = await accountWithResetToken();
    const page = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(page);
    await fillLikeAPasswordManager(page, "#password", GENERATED);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=Your password is changed", { timeout: 30_000 });
    await page.close();

    const consumed = await db.authToken.findFirst({ where: { userId, purpose: "password_reset" } });
    assert.ok(consumed?.usedAt, "the token was not marked used");

    // The same link again, in a fresh page.
    const second = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(second);
    await fillLikeAPasswordManager(second, "#password", `${GENERATED}-again`);
    await second.click('button[type="submit"]');
    await second.waitForSelector("text=no longer valid", { timeout: 30_000 });

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    assert.ok(
      await bcrypt.compare(GENERATED, user.passwordHash!),
      "the second submission changed the password",
    );
    await second.close();
  });

  test("an unknown token fails safely, without consuming anything", async () => {
    const page = await open("/reset-password?token=this-token-was-never-issued-000000");
    await hydrated(page);
    await fillLikeAPasswordManager(page, "#password", GENERATED);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=no longer valid", { timeout: 30_000 });

    // Still usable: the form is present rather than replaced by a dead end.
    assert.ok(await page.$("#password"), "the form disappeared on a failed reset");
    await page.close();
  });

  test("a password under the minimum is refused and leaves the token spendable", async () => {
    const { userId, token } = await accountWithResetToken();
    const page = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(page);

    // Short enough to fail the rule; `novalidate` is not set, so the browser's
    // own minlength check may catch it first. Either way the token must survive
    // — that is what stops a mistake from costing the person their only link.
    await fillLikeAPasswordManager(page, "#password", "short");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);

    const stillLive = await db.authToken.findFirst({ where: { userId, purpose: "password_reset" } });
    assert.equal(stillLive?.usedAt, null, "a rejected password consumed the reset token");

    // And the same page can still complete the reset: no loop, no dead end.
    await fillLikeAPasswordManager(page, "#password", GENERATED);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=Your password is changed", { timeout: 30_000 });
    await page.close();
  });

  test("success offers a route to sign in, and taking it lands on the login page", async () => {
    const { token } = await accountWithResetToken();
    const page = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(page);
    await fillLikeAPasswordManager(page, "#password", GENERATED);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=Your password is changed", { timeout: 30_000 });

    await page.click('button:has-text("Sign in")');
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await page.close();
  });

  test("the form carries exactly one password field", async () => {
    const { token } = await accountWithResetToken();
    const page = await open(`/reset-password?token=${encodeURIComponent(token)}`);
    await hydrated(page);

    const fields = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).filter(
        (i) => i.autocomplete === "new-password" || i.type === "password",
      ).length,
    );
    assert.equal(fields, 1, "a second password field is back");
    await page.close();
  });
});
