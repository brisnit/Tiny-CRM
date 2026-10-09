import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Does the theme actually apply before first paint?
 *
 * ## Why this suite exists
 *
 * `src/app/layout.tsx` renders one inline `<script>` into `<head>`. Its whole
 * job is to read the stored preference and set `html.dark` *before* the first
 * paint, so a visitor who chose dark mode does not get a flash of white on
 * every navigation. Nothing tested it. The shell's theme *control* was covered;
 * the thing that makes the choice survive a page load was not.
 *
 * It got covered because of a filter. React's development build logs
 * "Encountered a script tag while rendering React component" when it creates a
 * `<script>` during a client render, and `tests/browser/project-documents`
 * filters that one message out of its clean-console assertion — see the long
 * note there for why it is dev-only and why the warning's stated consequence
 * does not apply here. A filter is only safe if something else proves the
 * behaviour still works. This is that something.
 *
 * So these assertions are deliberately about observable effect rather than
 * about the script's existence: if the script stopped executing, stopped being
 * sent, lost its CSP nonce, or started reading a different key, every case
 * below fails. Asserting that a `<script>` tag is present in the markup would
 * have proven nothing.
 *
 * ## Why a real browser
 *
 * The script is executed by the browser during HTML parse, reads
 * `localStorage`, and consults `prefers-color-scheme`. None of those exist in a
 * server test, and the ordering — before paint, before hydration — is the
 * property under test.
 *
 * Needs no account, no object storage and no flags: every page used here is
 * public, so this suite always runs.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";

/** A public page that uses the root layout. */
const PAGE = "/login";

describe("theme initialization", () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  /**
   * Stores a preference, then loads the page again so the inline script runs
   * against it.
   *
   * The first visit exists only to give `localStorage` an origin to write to;
   * the assertion is always about the *second* load, which is the one where the
   * script reads a stored value during parse.
   */
  async function loadWithStoredTheme(
    stored: string | null,
    options: { colorScheme?: "dark" | "light" } = {},
  ): Promise<{ page: Page; dark: boolean }> {
    const page = await browser.newPage();
    if (options.colorScheme) await page.emulateMedia({ colorScheme: options.colorScheme });
    await page.goto(`${BASE_URL}${PAGE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate((value) => {
      if (value === null) localStorage.removeItem("tc-theme");
      else localStorage.setItem("tc-theme", value);
    }, stored);
    await page.goto(`${BASE_URL}${PAGE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // No wait: `documentElement` is read immediately, because the point is that
    // the class is already there. A wait would let a later effect set it and
    // the test would pass on the wrong mechanism.
    const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    return { page, dark };
  }

  test("a stored dark preference is applied during parse, not after hydration", async () => {
    const { page, dark } = await loadWithStoredTheme("dark");
    try {
      assert.equal(dark, true, "html.dark was absent on a load with tc-theme=dark");
    } finally {
      await page.close();
    }
  });

  test("a stored light preference wins over a dark system setting", async () => {
    // The direction that catches a script which ignores storage and reads only
    // the media query.
    const { page, dark } = await loadWithStoredTheme("light", { colorScheme: "dark" });
    try {
      assert.equal(dark, false, "html.dark was present on a load with tc-theme=light");
    } finally {
      await page.close();
    }
  });

  test("system follows prefers-color-scheme in both directions", async () => {
    const inDark = await loadWithStoredTheme("system", { colorScheme: "dark" });
    try {
      assert.equal(inDark.dark, true, "system with a dark system setting did not apply dark");
    } finally {
      await inDark.page.close();
    }

    const inLight = await loadWithStoredTheme("system", { colorScheme: "light" });
    try {
      assert.equal(inLight.dark, false, "system with a light system setting applied dark");
    } finally {
      await inLight.page.close();
    }
  });

  test("no stored preference falls back to the system setting", async () => {
    // `localStorage.getItem` returns null here, which the script defaults to
    // 'system'. A script that treated the missing key as 'light' would pass the
    // case above and fail this one.
    const { page, dark } = await loadWithStoredTheme(null, { colorScheme: "dark" });
    try {
      assert.equal(dark, true, "a first-time visitor preferring dark was served light");
    } finally {
      await page.close();
    }
  });
});
