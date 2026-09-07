#!/usr/bin/env node
/**
 * The hosted account lifecycle, end to end, in one pass.
 *
 * Driven entirely through the deployed HTTP surface with tokens taken from
 * emails that were actually delivered. Nothing here weakens SSO, rate limits,
 * RLS, token lifetimes or any auth control.
 *
 * ---------------------------------------------------------------------------
 * Two rules this script exists to enforce
 * ---------------------------------------------------------------------------
 *
 * 1. **A rejection is not proof of single use.** A token that was never
 *    consumed is also rejected — because it expired, or never existed. So every
 *    single-use claim here requires the token to be *observed as consumed*
 *    first (usedAt set) and *observed as unexpired* at the moment of reuse.
 *    Otherwise the result is reported as inconclusive, not as a pass.
 *
 * 2. **Never compare a Prisma timestamp in JavaScript.** Prisma maps DateTime
 *    to `timestamp` WITHOUT time zone and stores the UTC instant; the `pg`
 *    driver then reads it back as *local* time. On a host west of UTC an
 *    expired token therefore looks live by exactly the UTC offset — which is
 *    how an earlier run concluded a token was valid, watched the application
 *    correctly reject it as expired, and reported the application as broken.
 *    Every expiry decision below is made by PostgreSQL, in SQL.
 *
 *   ADMIN_URL=… BASE_URL=… VERCEL_BYPASS=… EMAIL=… OLD_PASSWORD=… NEW_PASSWORD=…
 *   VERIFY_TOKEN=… RESET_TOKEN=… node scripts/hosted-lifecycle.mjs
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_URL ?? "";
const BYPASS = process.env.VERCEL_BYPASS ?? "";
const EMAIL = process.env.EMAIL ?? "";
const OLD = process.env.OLD_PASSWORD ?? "";
const NEW = process.env.NEW_PASSWORD ?? "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN ?? "";
const RESET_TOKEN = process.env.RESET_TOKEN ?? "";

for (const [k, v] of Object.entries({ BASE_URL: BASE, ADMIN_URL: ADMIN, EMAIL, OLD_PASSWORD: OLD, NEW_PASSWORD: NEW })) {
  if (!v) { console.error(`${k} is required.`); process.exit(2); }
}

const headers = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};
const results = [];
let pass = 0, fail = 0, inconclusive = 0;
const ok = (n, d = "") => { pass++; results.push(["PASS", n]); console.log(`  PASS          ${n}${d ? ` — ${d}` : ""}`); };
const no = (n, d = "") => { fail++; results.push(["FAIL", n]); console.log(`  FAIL          ${n}${d ? ` — ${d}` : ""}`); };
const meh = (n, d = "") => { inconclusive++; results.push(["INCONCLUSIVE", n]); console.log(`  INCONCLUSIVE  ${n}${d ? ` — ${d}` : ""}`); };
const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

const hash = (t) => createHash("sha256").update(t).digest("hex");

const db = new Client({ connectionString: ADMIN, connectionTimeoutMillis: 20_000 });
await db.connect();

/** Token state, with expiry decided by PostgreSQL rather than by JavaScript. */
async function tokenState(token) {
  const { rows } = await db.query(
    `SELECT purpose,
            "usedAt" IS NOT NULL          AS used,
            "expiresAt" <= (now() AT TIME ZONE 'UTC') AS expired,
            "expiresAt"
       FROM "AuthToken" WHERE "tokenHash" = $1`,
    [hash(token)],
  );
  return rows[0] ?? null;
}

const browser = await chromium.launch();

async function signIn(password) {
  const ctx = await browser.newContext({ extraHTTPHeaders: headers });
  ctx.setDefaultTimeout(90_000);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  const inside = await page
    .waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 60_000 })
    .then(() => true).catch(() => false);
  return { ctx, page, inside };
}

async function openVerify(token) {
  const ctx = await browser.newContext({ extraHTTPHeaders: headers });
  ctx.setDefaultTimeout(90_000);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/verify-email?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  await ctx.close();
  return { verified: /Email verified|address is confirmed/.test(text), text };
}

async function doReset(token, password) {
  const ctx = await browser.newContext({ extraHTTPHeaders: headers });
  ctx.setDefaultTimeout(90_000);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reset-password?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  if ((await page.locator('input[name="password"]').count()) === 0) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    await ctx.close();
    return { done: false, text };
  }
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirm"]', password);
  await page.locator('button[type="submit"]').first().click();
  const done = await page
    .waitForFunction(() => document.body.innerText.includes("password is changed"), { timeout: 60_000 })
    .then(() => true).catch(() => false);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  await ctx.close();
  return { done, text };
}

/** The reason the application recorded, from its own audit trail. */
async function lastResetOutcome() {
  const { rows } = await db.query(
    `SELECT metadata FROM "AuditLog"
      WHERE action = 'auth.password_reset_completed'
      ORDER BY "createdAt" DESC LIMIT 1`,
  );
  try { return JSON.parse(rows[0]?.metadata ?? "{}").outcome ?? null; } catch { return null; }
}

try {
  head("Pre-flight — refuse to run a test that cannot mean anything");
  const v0 = VERIFY_TOKEN ? await tokenState(VERIFY_TOKEN) : null;
  const r0 = RESET_TOKEN ? await tokenState(RESET_TOKEN) : null;
  if (VERIFY_TOKEN) console.log(`  verification token: found=${!!v0} used=${v0?.used} expired=${v0?.expired}`);
  if (RESET_TOKEN) console.log(`  reset token:        found=${!!r0} used=${r0?.used} expired=${r0?.expired}`);

  if (RESET_TOKEN && (!r0 || r0.used || r0.expired)) {
    console.log("\n  The reset token is not usable. Refusing to continue: a rejection now");
    console.log("  would prove nothing about single use, and reporting it as a pass would");
    console.log("  be a false green. Issue a fresh reset email and re-run.\n");
    process.exit(3);
  }

  // ---------------------------------------------------------------- verify
  if (VERIFY_TOKEN && v0 && !v0.used && !v0.expired) {
    head("Email verification");
    const first = await openVerify(VERIFY_TOKEN);
    if (first.verified) ok("verification link consumed"); else no("verification link consumed", first.text.slice(0, 110));

    const { rows: [u] } = await db.query(`SELECT "emailVerifiedAt" FROM "User" WHERE email = $1`, [EMAIL]);
    if (u?.emailVerifiedAt) ok("the account is now verified"); else no("account marked verified");

    const v1 = await tokenState(VERIFY_TOKEN);
    if (v1?.used) ok("the verification token is marked used"); else no("verification token marked used");

    // Single use, only claimable because it was consumed and is still in date.
    if (v1?.used && !v1.expired) {
      const second = await openVerify(VERIFY_TOKEN);
      if (!second.verified) ok("reuse rejected while still within its lifetime — attributable to consumption, not expiry");
      else no("reuse was accepted", "single use is broken");
    } else {
      meh("verification single-use", "token expired before reuse could be attempted");
    }
  } else if (VERIFY_TOKEN) {
    meh("email verification", `token used=${v0?.used} expired=${v0?.expired}`);
  }

  // ----------------------------------------------------------------- reset
  head("Password reset");
  const session = await signIn(OLD);
  if (session.inside) ok("sign in with the original password"); else no("sign in with the original password");
  const before = await session.page.request.get(`${BASE}/welcome`);
  if (before.ok()) ok("that session reaches the app before the reset"); else no("session live before reset", `http ${before.status()}`);

  const { rows: [e0] } = await db.query(`SELECT "sessionEpoch" FROM "User" WHERE email = $1`, [EMAIL]);

  const reset = await doReset(RESET_TOKEN, NEW);
  if (reset.done) ok("reset completed with the emailed token");
  else no("reset completed", `outcome=${await lastResetOutcome()} — ${reset.text.slice(0, 90)}`);

  const r1 = await tokenState(RESET_TOKEN);
  if (r1?.used) ok("the reset token is marked used"); else no("reset token marked used");

  head("Session revocation");
  const { rows: [e1] } = await db.query(`SELECT "sessionEpoch" FROM "User" WHERE email = $1`, [EMAIL]);
  if (e1.sessionEpoch > e0.sessionEpoch) ok("the session epoch was bumped", `${e0.sessionEpoch} → ${e1.sessionEpoch}`);
  else no("session epoch bumped", `${e0.sessionEpoch} → ${e1.sessionEpoch}`);

  const after = await session.page.request.get(`${BASE}/welcome`, { maxRedirects: 0 }).catch(() => null);
  const status = after?.status() ?? 0;
  if (status >= 300 || status === 401) ok("the pre-reset session no longer works", `http ${status}`);
  else no("pre-reset session revoked", `http ${status}`);

  head("Passwords");
  const oldTry = await signIn(OLD);
  if (!oldTry.inside) ok("the old password is rejected"); else no("the old password still works");
  await oldTry.ctx.close();
  const newTry = await signIn(NEW);
  if (newTry.inside) ok("the new password works"); else no("the new password works");
  await newTry.ctx.close();

  head("Reset token single use");
  const r2 = await tokenState(RESET_TOKEN);
  if (r2?.used && !r2.expired) {
    const again = await doReset(RESET_TOKEN, "Should-Never-Apply-9xQ!");
    const outcome = await lastResetOutcome();
    if (!again.done && outcome === "already_used") {
      ok("reuse rejected, and the application recorded the reason as already_used");
    } else if (!again.done) {
      meh("reset single-use", `rejected but recorded outcome was ${outcome}`);
    } else no("reuse was accepted", "single use is broken");
  } else {
    meh("reset single-use", `token used=${r2?.used} expired=${r2?.expired} — cannot attribute a rejection to consumption`);
  }

  head("Invalid token");
  const bad = await doReset("totally-invalid-token-0000000000000000000000", "Never-Applied-5mN!");
  const badOutcome = await lastResetOutcome();
  if (!bad.done && badOutcome === "not_found") ok("an unknown token is refused, recorded as not_found");
  else if (!bad.done) meh("invalid token", `refused, recorded as ${badOutcome}`);
  else no("an invalid token was accepted");

  head("Controls unchanged");
  const { rows: [role] } = await db.query(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'tinycrm_app'`,
  );
  if (role && !role.rolsuper && !role.rolbypassrls) ok("the runtime role is still unprivileged");
  else no("runtime role changed", JSON.stringify(role));

  const { rows: [rls] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity`,
  );
  if (rls.n >= 30) ok(`RLS still forced on ${rls.n} tables`); else no("RLS coverage dropped", `${rls.n} tables`);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const sso = await anonPage.request.get(`${BASE}/api/health`, { maxRedirects: 0 }).catch(() => null);
  if (sso && sso.status() >= 300 && sso.status() < 400) ok("Vercel SSO protection is still in force for an unauthenticated caller");
  else no("SSO protection", `http ${sso?.status()}`);
  await anon.close();
} catch (error) {
  no("run completed", String(error?.message ?? error).slice(0, 200));
} finally {
  await browser.close();
  await db.end().catch(() => {});
}

console.log(`\n${"=".repeat(66)}`);
console.log(`  passed ${pass}   failed ${fail}   inconclusive ${inconclusive}`);
console.log("=".repeat(66));
console.log(`\nHOSTED ACCOUNT LIFECYCLE: ${fail === 0 && inconclusive === 0 ? "PASS" : fail > 0 ? "FAIL" : "INCOMPLETE"}\n`);
process.exit(fail === 0 && inconclusive === 0 ? 0 : 1);
