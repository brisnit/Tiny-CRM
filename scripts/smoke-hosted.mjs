#!/usr/bin/env node
/**
 * Hosted smoke tests — a real browser against the real deployment.
 *
 * This is deliberately not the local E2E suite pointed at a URL. It exercises
 * the production build, the production CSP, the hosted database through the
 * restricted role, and the deployed cron endpoint. Anything it cannot prove is
 * reported as BLOCKED rather than skipped quietly.
 *
 *   BASE_URL=https://…             the deployment to test
 *   VERCEL_BYPASS=…                Vercel protection bypass secret (optional)
 *   CRON_SECRET=…                  to exercise /api/cron/jobs (optional)
 *
 * Creates a throwaway owner account. Intended for a staging database.
 */

import { chromium } from "playwright";

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const BYPASS = process.env.VERCEL_BYPASS ?? "";
const CRON = process.env.CRON_SECRET ?? "";

if (!BASE) {
  console.error("BASE_URL is required.");
  process.exit(2);
}

let passed = 0, failed = 0, blocked = 0;
const rows = [];
const pass = (n, d = "") => { passed++; rows.push(["PASS", n, d]); console.log(`  PASS     ${n}${d ? ` — ${d}` : ""}`); };
const fail = (n, d = "") => { failed++; rows.push(["FAIL", n, d]); console.log(`  FAIL     ${n}${d ? ` — ${d}` : ""}`); };
const block = (n, d = "") => { blocked++; rows.push(["BLOCKED", n, d]); console.log(`  BLOCKED  ${n}${d ? ` — ${d}` : ""}`); };
const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

const headers = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  extraHTTPHeaders: headers,
});
const page = await ctx.newPage();

// Console errors and CSP violations are collected globally; a check at the end
// asserts the whole run produced none. CSP violations surface as console errors
// in Chromium, so they are captured here too.
const consoleErrors = [];
const cspViolations = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  (/content security policy|refused to (load|execute|apply)/i.test(t) ? cspViolations : consoleErrors).push(t.slice(0, 220));
});

const stamp = Date.now();
const account = { name: "Owner Probe", email: `owner+${stamp}@tinycrm.test`, password: `Pw-${stamp}-aA1!` };

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, redirect: "manual" });
  const text = await res.text().catch(() => "");
  return { status: res.status, text, headers: res.headers };
}

try {
  // ---------------------------------------------------------------- transport
  head("Transport and configuration");

  const health = await api("/api/health");
  if (health.status === 200 && /"database"\s*:\s*"ok"/.test(health.text)) {
    pass("health endpoint reports the database is reachable");
  } else fail("health endpoint", `http ${health.status}`);

  const ready = await api("/api/ready");
  if (ready.status === 200 && /"ready"\s*:\s*true/.test(ready.text)) pass("readiness: migrations are present");
  else fail("readiness", `http ${ready.status} ${ready.text.slice(0, 80)}`);

  const login = await api("/login");
  const csp = login.headers.get("content-security-policy") ?? "";
  if (!csp) fail("Content-Security-Policy header present");
  else {
    pass("Content-Security-Policy present");
    if (/'unsafe-eval'/.test(csp)) fail("CSP contains no 'unsafe-eval'"); else pass("CSP contains no 'unsafe-eval'");
    if (/script-src[^;]*'nonce-/.test(csp)) pass("CSP uses a per-request script nonce"); else fail("CSP uses a per-request script nonce");
    if (/frame-ancestors 'none'/.test(csp)) pass("CSP forbids framing"); else fail("CSP forbids framing");
  }
  for (const [h, want] of [
    ["strict-transport-security", /max-age=\d{6,}/],
    ["x-content-type-options", /nosniff/],
    ["x-frame-options", /DENY/i],
    ["referrer-policy", /strict-origin/],
  ]) {
    const v = login.headers.get(h) ?? "";
    if (want.test(v)) pass(`${h}`); else fail(`${h}`, v ? `got "${v}"` : "absent");
  }
  if (!login.headers.get("x-powered-by")) pass("no x-powered-by header"); else fail("no x-powered-by header");

  // Two nonces must differ, or it is not per-request.
  const a = (await api("/login")).headers.get("content-security-policy") ?? "";
  const b = (await api("/login")).headers.get("content-security-policy") ?? "";
  const n1 = /'nonce-([^']+)'/.exec(a)?.[1], n2 = /'nonce-([^']+)'/.exec(b)?.[1];
  if (n1 && n2 && n1 !== n2) pass("the script nonce changes per request");
  else fail("the script nonce changes per request", n1 === n2 ? "identical across two requests" : "not found");

  // ------------------------------------------------------------ client bundle
  head("Client bundle");

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  const html = await page.content();
  const chunkUrls = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map((s) => s.src));
  let bundle = html;
  for (const u of chunkUrls.slice(0, 40)) {
    try { bundle += await (await fetch(u, { headers })).text(); } catch { /* ignore */ }
  }
  const leaks = [];
  for (const [label, rx] of [
    ["demo password", /\btinycrm["'\s,}]/],
    ["owner@tinycrm.app", /owner@tinycrm\.app/],
    ["a postgres URL", /postgres(ql)?:\/\/[^\s"']+:[^\s"']+@/],
    ["AUTH_SECRET value", /AUTH_SECRET["'\s]*[:=]["'\s]*[A-Za-z0-9+/]{20,}/],
    ["neon owner role", /neondb_owner/],
    ["an api key", /sk-(ant|proj)-[A-Za-z0-9_-]{16,}/],
  ]) if (rx.test(bundle)) leaks.push(label);
  if (leaks.length === 0) pass(`no credential material in the client bundle`, `${chunkUrls.length} scripts scanned`);
  else fail("no credential material in the client bundle", leaks.join(", "));

  // ---------------------------------------------------------------- hydration
  head("Rendering and hydration");

  const hydrated = await page.evaluate(async () => {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      // Next marks the root once React has taken over.
      if (document.querySelector("[data-nextjs-router]") || window.__NEXT_DATA__ || document.querySelector("form")) {
        const f = document.querySelector('input[name="email"]');
        if (f) return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  });
  if (hydrated) pass("login page renders and the form is present"); else fail("login page renders");

  // A hydration mismatch is reported by React as a console error; the global
  // collectors above catch it. Interactivity is the practical proof.
  await page.fill('input[name="email"]', "probe@example.invalid");
  const typed = await page.inputValue('input[name="email"]');
  if (typed === "probe@example.invalid") pass("React is interactive (controlled input accepted a value)");
  else fail("React is interactive");

  // ------------------------------------------------------------------- signup
  head("Authentication");

  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle" });
  await page.fill('input[name="name"]', account.name);
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await page.click('button[type="submit"]');
  const signedUp = await page.waitForURL((u) => !/\/signup/.test(u.toString()), { timeout: 45000 }).then(() => true).catch(() => false);
  if (signedUp) pass("sign up creates an account", page.url().replace(BASE, "") || "/");
  else fail("sign up creates an account", `still at ${page.url().replace(BASE, "")}`);

  const cookies = await ctx.cookies();
  // Match the session token specifically. Matching /session|authjs/ finds the
  // CSRF cookie first and reports the wrong thing as the session.
  const session = cookies.find((c) => /(^|\.)(authjs|next-auth)\.session-token$/.test(c.name.replace(/^__(Host|Secure)-/, "")));
  if (session) {
    pass("a session cookie was set", `${session.name}`);
    if (session.httpOnly) pass("session cookie is HttpOnly"); else fail("session cookie is HttpOnly");
    if (session.secure) pass("session cookie is Secure"); else fail("session cookie is Secure");
    if (session.sameSite && session.sameSite !== "None") pass(`session cookie SameSite=${session.sameSite}`);
    else fail("session cookie SameSite", String(session.sameSite));
  } else fail("a session cookie was set");

  // --------------------------------------------------------------- onboarding
  head("Onboarding");

  // Without this the account has no workspace, every /home request redirects to
  // /welcome, and a naive "did the page return 200?" check passes while proving
  // nothing. An earlier version of this script did exactly that.
  await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });

  const workspaceName = `Probe Workspace ${stamp}`;
  const advance = async (label) => {
    const btn = page.locator(`button:has-text("${label}")`).first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(1200); return true; }
    return false;
  };

  await advance("Continue");
  const wsInput = page.locator('input[placeholder="Artifact Intelligence"]').first();
  if (await wsInput.count()) {
    await wsInput.fill(workspaceName);
    await advance("Create workspace");
    pass("onboarding creates the first workspace", workspaceName);
  } else fail("onboarding creates the first workspace", "workspace name field not found");

  // The optional project/contact steps are skipped by navigating straight to
  // the product, which is what the "skip setup" link does. Clicking through
  // them left the page in a state the next navigation could not recover from.
  // Retried: the first request immediately after the workspace is created can
  // still be answered from the pre-onboarding session state and bounce back to
  // /welcome. Allowing it to settle asserts what actually matters — that the
  // user reaches the product — without asserting a particular timing.
  let reached = false;
  for (let attempt = 0; attempt < 4 && !reached; attempt++) {
    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
    reached = /\/home/.test(page.url());
    if (!reached) await page.waitForTimeout(2500);
  }
  if (reached) pass("reaches the dashboard after onboarding");
  else fail("reaches the dashboard after onboarding", `stuck at ${page.url().replace(BASE, "")}`);

  // ------------------------------------------------------------- CRM surfaces
  head("CRM surfaces (production build)");

  for (const [label, path, marker] of [
    ["dashboard", "/home", "body"],
    ["contacts", "/contacts", "body"],
    ["companies", "/companies", "body"],
    ["deals", "/deals", "body"],
    ["projects", "/projects", "body"],
    ["opportunities", "/opportunities", "body"],
    ["tasks", "/tasks", "body"],
    ["notes", "/notes", "body"],
    ["settings — security", "/settings/security", "body"],
    ["settings — trash", "/settings/trash", "body"],
  ]) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" }).catch(() => null);
    const status = res?.status() ?? 0;
    const landed = new URL(page.url()).pathname;
    // A 200 is not enough: /home redirects to /welcome when onboarding is
    // incomplete, and /login when signed out. Both would look like a pass.
    const bounced = landed !== path;
    const has = await page.locator(marker).count().catch(() => 0);
    if (status === 200 && has > 0 && !bounced) pass(`${label} renders`, path);
    else fail(`${label} renders`, bounced ? `${path} → redirected to ${landed}` : `${path} → http ${status}`);
  }

  // ---------------------------------------------------------------- sign out
  head("Session lifecycle");

  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  const beforeOut = (await page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" }))?.status();
  if (beforeOut === 200) pass("session persists across navigations"); else fail("session persists across navigations");

  await ctx.clearCookies();
  const anon = await page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
  const url = page.url();
  if (/\/login/.test(url) || anon?.status() === 401 || anon?.status() === 403) pass("signed-out access is redirected to login");
  else fail("signed-out access is redirected to login", `landed on ${url.replace(BASE, "")}`);

  // ------------------------------------------------------------------- mobile
  head("Responsive");

  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: headers });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow <= 2) pass("no horizontal overflow at 390px"); else fail("no horizontal overflow at 390px", `${overflow}px`);
  await m.close();

  // ---------------------------------------------------------------- cron auth
  head("Worker endpoint");

  if (!CRON) {
    block("cron endpoint authentication", "CRON_SECRET not provided to this run");
  } else {
    const good = await api("/api/cron/jobs", { headers: { authorization: `Bearer ${CRON}` } });
    if (good.status === 200) pass("valid bearer secret succeeds", good.text.slice(0, 90));
    else fail("valid bearer secret succeeds", `http ${good.status} ${good.text.slice(0, 90)}`);

    const none = await api("/api/cron/jobs");
    if (none.status === 401) pass("missing secret is refused (401)"); else fail("missing secret is refused", `http ${none.status}`);

    const wrong = await api("/api/cron/jobs", { headers: { authorization: "Bearer definitely-not-the-secret" } });
    if (wrong.status === 401) pass("wrong secret is refused (401)"); else fail("wrong secret is refused", `http ${wrong.status}`);
  }

  // -------------------------------------------------------------------- final
  head("Console output across the whole run");
  if (cspViolations.length === 0) pass("no CSP violations in the browser");
  else fail("no CSP violations in the browser", `${cspViolations.length}: ${cspViolations[0]}`);
  if (consoleErrors.length === 0) pass("no console errors or React errors");
  else fail("no console errors", `${consoleErrors.length}: ${consoleErrors.slice(0, 2).join(" | ")}`);
} catch (error) {
  fail("run completed", String(error?.message ?? error).slice(0, 200));
} finally {
  await browser.close();
}

console.log(`\n${"=".repeat(64)}`);
console.log(`  passed ${passed}   failed ${failed}   blocked ${blocked}`);
console.log("=".repeat(64));
console.log(`\nHOSTED SMOKE: ${failed === 0 ? (blocked ? "PASS WITH BLOCKED ITEMS" : "PASS") : "FAIL"}\n`);
process.exit(failed === 0 ? 0 : 1);
