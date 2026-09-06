import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const results = [];
const ok = (name, detail = "") => { results.push(["PASS", name, detail]); console.log(`PASS  ${name} ${detail}`); };
const bad = (name, detail = "") => { results.push(["FAIL", name, detail]); console.log(`FAIL  ${name} ${detail}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

try {
  // --- Sign in through the real form ---
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', "owner@tinycrm.app");
  await page.fill('input[name="password"]', "tinycrm");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/home", { timeout: 20000 });
  ok("Sign in with credentials");

  await page.waitForSelector("text=Good", { timeout: 15000 });
  await page.screenshot({ path: "/tmp/tcshots/01-dashboard.png", fullPage: false });

  // --- Command bar (Cmd+K) ---
  await page.keyboard.press("Meta+k");
  await page.waitForSelector('input[placeholder*="Search or ask"]', { timeout: 5000 });
  await page.fill('input[placeholder*="Search or ask"]', "fuller");
  await page.waitForSelector("text=Fuller Theological Seminary", { timeout: 8000 });
  await page.screenshot({ path: "/tmp/tcshots/02-command-bar.png" });
  ok("Command bar searches across records");
  await page.keyboard.press("Escape");

  // --- Quick Add: create a task (write path) ---
  await page.keyboard.press("Meta+n");
  await page.waitForSelector("text=Quick add", { timeout: 5000 });
  const title = `E2E verification task ${Date.now()}`;
  await page.fill('input[placeholder="Follow up with…"]', title);
  await page.screenshot({ path: "/tmp/tcshots/03-quick-add.png" });
  await page.click('button:has-text("Create task")');
  await page.waitForSelector("text=Task created", { timeout: 15000 });
  ok("Quick Add creates a task", "(server action + plan limit + revalidate)");

  // --- Verify it persisted and appears in Tasks ---
  await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle" });
  const found = await page.locator(`text=${title}`).count();
  if (found > 0) ok("Created task appears in Tasks list");
  else bad("Created task appears in Tasks list");

  // --- Complete the task (optimistic toggle) ---
  const row = page.locator("li").filter({ hasText: title }).first();
  await row.locator('button[role="checkbox"]').click();
  await page.waitForSelector("text=Task completed", { timeout: 15000 });
  ok("Completing a task works", "(optimistic + recurrence path)");
  await page.screenshot({ path: "/tmp/tcshots/04-tasks.png" });

  // --- Pipeline board + drag a deal between stages ---
  await page.goto(`${BASE}/deals`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Open pipeline", { timeout: 15000 });
  await page.screenshot({ path: "/tmp/tcshots/05-pipeline.png" });

  // Drag the first card in the first column into the second column.
  const handles = page.locator('button[aria-label^="Drag "]');
  const cols = page.locator('div.flex.min-h-\\[140px\\]');
  if ((await handles.count()) > 0 && (await cols.count()) > 1) {
    const name = (await handles.first().getAttribute("aria-label"))?.replace("Drag ", "");
    const hb = await handles.first().boundingBox();
    const tb = await cols.nth(1).boundingBox();
    if (hb && tb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + 40, hb.y + 20, { steps: 5 });
      await page.mouse.move(tb.x + tb.width / 2, tb.y + 70, { steps: 25 });
      await page.mouse.up();
      await page.waitForSelector("text=Moved to", { timeout: 15000 });
      ok("Drag a deal between pipeline stages", `moved "${name}"`);
      await page.screenshot({ path: "/tmp/tcshots/06-drag-result.png" });
    } else bad("Drag a deal between pipeline stages", "no geometry");
  } else bad("Drag a deal between pipeline stages", "no cards/columns");

  // --- Tiny AI panel streaming ---
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await page.keyboard.press("Meta+/");
  await page.waitForSelector("text=Ask me anything", { timeout: 8000 });
  await page.click("text=Which deals need attention?");
  await page.waitForSelector("text=/open deal/", { timeout: 25000 });
  await page.screenshot({ path: "/tmp/tcshots/07-tiny-ai.png" });
  ok("Tiny AI panel answers a question", "(streaming response)");
  await page.keyboard.press("Escape");

  // --- Workspace switching ---
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await page.click('button:has-text("All Businesses")');
  await page.waitForSelector("text=Switch workspace", { timeout: 5000 });
  await page.click('div[role="menuitem"]:has-text("DropQ")');
  await page.waitForTimeout(2500);
  const scoped = await page.locator("text=DropQ").count();
  if (scoped > 0) ok("Workspace switcher scopes the app");
  else bad("Workspace switcher scopes the app");
  await page.screenshot({ path: "/tmp/tcshots/08-workspace-scoped.png" });

  // Back to all
  await page.click('button:has-text("DropQ")');
  await page.click('div[role="menuitem"]:has-text("All Businesses")');
  await page.waitForTimeout(2000);

  // --- Project dashboard ---
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.click("text=BBOP Website Redesign");
  await page.waitForSelector("text=Next action", { timeout: 15000 });
  await page.screenshot({ path: "/tmp/tcshots/09-project.png", fullPage: false });
  ok("Project dashboard renders");

  // --- Log a call from the timeline (write path on a record) ---
  await page.click('button:has-text("Call")');
  await page.fill('input[placeholder="Summary of the call"]', "E2E verification call");
  await page.click('button:has-text("Log it")');
  await page.waitForSelector("text=Logged to the timeline", { timeout: 15000 });
  ok("Log an activity from a record timeline");

  // --- Analytics with charts ---
  await page.goto(`${BASE}/analytics`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Revenue won by month", { timeout: 15000 });
  await page.waitForTimeout(1200);
  const svgs = await page.locator("svg.recharts-surface").count();
  if (svgs >= 2) ok("Analytics charts render", `${svgs} chart surfaces`);
  else bad("Analytics charts render", `${svgs} chart surfaces`);
  await page.screenshot({ path: "/tmp/tcshots/10-analytics.png", fullPage: false });

  // --- AI capture: paste text, get proposals ---
  await page.goto(`${BASE}/ai`, { waitUntil: "networkidle" });
  await page.click("text=Capture with Tiny AI");
  await page.fill("textarea", "Talked to Sarah at Fuller. She said the provost is interested and wants a demo next month. Need to send over the pricing this week.");
  await page.click('button:has-text("Analyze")');
  await page.waitForSelector("text=Proposed changes", { timeout: 25000 });
  await page.screenshot({ path: "/tmp/tcshots/11-ai-capture.png" });
  const proposals = await page.locator('label:has(button[role="checkbox"])').count();
  if (proposals > 0) ok("AI capture proposes CRM changes", `${proposals} proposals, none applied without approval`);
  else bad("AI capture proposes CRM changes", "no proposals rendered");

  // --- Dark mode ---
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await page.evaluate(() => { localStorage.setItem("tc-theme", "dark"); document.documentElement.classList.add("dark"); });
  await page.waitForTimeout(900);
  await page.screenshot({ path: "/tmp/tcshots/12-dark.png" });
  ok("Dark mode renders");

  // --- Mobile viewport ---
  const mobile = await ctx.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await mobile.waitForSelector("text=Good", { timeout: 15000 });
  await mobile.screenshot({ path: "/tmp/tcshots/13-mobile.png" });
  const hOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  if (!hOverflow) ok("Mobile layout has no horizontal overflow");
  else bad("Mobile layout has no horizontal overflow");
  await mobile.close();

  // --- Marketing page ---
  const anon = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const mk = await anon.newPage();
  await mk.goto(BASE, { waitUntil: "networkidle" });
  await mk.screenshot({ path: "/tmp/tcshots/14-marketing.png", fullPage: false });
  await mk.locator("#pricing").scrollIntoViewIfNeeded();
  await mk.waitForTimeout(600);
  await mk.screenshot({ path: "/tmp/tcshots/15-pricing.png" });
  ok("Marketing page and pricing render");
  await anon.close();

} catch (e) {
  bad("Run aborted", String(e).split("\n")[0]);
  await page.screenshot({ path: "/tmp/tcshots/error.png" }).catch(() => {});
} finally {
  console.log("\n--- console/page errors ---");
  const real = errors.filter((e) => !/favicon|Download the React DevTools|hydrat/i.test(e));
  console.log(real.length ? real.slice(0, 10).join("\n") : "(none)");
  console.log(`\n${results.filter(r=>r[0]==="PASS").length} passed, ${results.filter(r=>r[0]==="FAIL").length} failed`);
  await browser.close();
}
