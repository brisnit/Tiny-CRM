import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright";

import { markImported, runnerMark, tracedLaunch } from "./_trace";

/**
 * The show/hide password control.
 *
 * The control has one hard requirement — it must not touch the value — and one
 * easy way to break it: re-mounting the input, or keying it off visibility,
 * loses whatever the browser wrote there. So these tests fill the field the way
 * a password manager does (native setter, no events) and then check the exact
 * value survives a toggle, in both directions.
 *
 * The value is compared inside the page and only a boolean crosses back, so no
 * password appears in an assertion message.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const GENERATED = "Xr7-quiet-Harbor-4192";

let browser: Browser;

async function fillLikeAPasswordManager(page: Page, selector: string, value: string) {
  await page.evaluate(
    ({ selector, value }) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    },
    { selector, value },
  );
}

async function holds(page: Page, selector: string, value: string) {
  return page.evaluate(
    ({ selector, value }) => (document.querySelector(selector) as HTMLInputElement).value === value,
    { selector, value },
  );
}

/** Every page in the product where a password is typed. */
const SURFACES = [
  { name: "sign in", path: "/login", selector: "#password", autocomplete: "current-password" },
  { name: "sign up", path: "/signup", selector: "#password", autocomplete: "new-password" },
  {
    name: "reset password",
    path: "/reset-password?token=this-token-was-never-issued-000000",
    selector: "#password",
    autocomplete: "new-password",
  },
];

markImported("password-visibility");

describe("show/hide password", () => {
  before(async () => {
    runnerMark("before:start", { suite: "password-visibility" });
    browser = await tracedLaunch("password-visibility");
    runnerMark("before:end", { suite: "password-visibility" });
  });
  after(async () => { await browser?.close(); });

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      test("starts hidden, with the right autocomplete for the surface", async () => {
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(surface.selector, { timeout: 60_000 });

        const field = page.locator(surface.selector);
        assert.equal(await field.getAttribute("type"), "password", "the field did not start masked");
        // Password managers key off this; losing it is how a field stops being
        // offered a fill, or gets offered the wrong one.
        assert.equal(await field.getAttribute("autocomplete"), surface.autocomplete);
        await page.close();
      });

      test("toggling reveals and re-hides, and the accessible name says which", async () => {
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(surface.selector, { timeout: 60_000 });

        const field = page.locator(surface.selector);
        const toggle = page.getByRole("button", { name: "Show password" });
        await toggle.click();

        assert.equal(await field.getAttribute("type"), "text", "the value was not revealed");
        await page.getByRole("button", { name: "Hide password" }).waitFor({ timeout: 5000 });

        await page.getByRole("button", { name: "Hide password" }).click();
        assert.equal(await field.getAttribute("type"), "password", "the value was not re-masked");
        await page.getByRole("button", { name: "Show password" }).waitFor({ timeout: 5000 });
        await page.close();
      });

      test("a password-manager fill survives being revealed and hidden again", async () => {
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(surface.selector, { timeout: 60_000 });
        await page.waitForTimeout(750); // hydration

        await fillLikeAPasswordManager(page, surface.selector, GENERATED);
        assert.ok(await holds(page, surface.selector, GENERATED), "the fill did not land");

        await page.getByRole("button", { name: "Show password" }).click();
        assert.ok(
          await holds(page, surface.selector, GENERATED),
          "revealing the password changed the value",
        );

        await page.getByRole("button", { name: "Hide password" }).click();
        assert.ok(
          await holds(page, surface.selector, GENERATED),
          "re-hiding the password changed the value",
        );
        await page.close();
      });

      test("toggling does not submit the form", async () => {
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(surface.selector, { timeout: 60_000 });
        await page.waitForTimeout(750);

        const before = page.url();
        let navigated = false;
        page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigated = true; });

        await page.getByRole("button", { name: "Show password" }).click();
        await page.waitForTimeout(1500);

        assert.equal(navigated, false, "toggling visibility navigated the page");
        assert.equal(page.url(), before, "toggling visibility submitted the form");
        // The field is still there, so nothing was torn down and re-rendered.
        assert.ok(await page.$(surface.selector), "the field disappeared after a toggle");
        await page.close();
      });

      test("the toggle is reachable and operable from the keyboard", async () => {
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(surface.selector, { timeout: 60_000 });
        await page.waitForTimeout(750);

        await fillLikeAPasswordManager(page, surface.selector, GENERATED);
        await page.focus(surface.selector);
        // The control sits immediately after its field in the tab order.
        await page.keyboard.press("Tab");

        const focusedName = await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        );
        assert.equal(focusedName, "Show password", "the toggle is not the next tab stop");

        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator(surface.selector).getAttribute("type"),
          "text",
          "the toggle did not respond to the keyboard",
        );
        assert.ok(
          await holds(page, surface.selector, GENERATED),
          "operating the toggle from the keyboard changed the value",
        );
        await page.close();
      });
    });
  }
});
