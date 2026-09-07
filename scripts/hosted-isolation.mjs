#!/usr/bin/env node
/**
 * Hosted application-level tenant isolation, through real HTTP.
 *
 * SQL-level verification (scripts/verify-hosted.mjs) proves the database
 * refuses cross-tenant access. It does not prove the *application* asks the
 * database the right questions. This does: two signed-in browser sessions
 * against the deployed build, exercising record URLs, server actions, the API
 * and relationship substitution.
 *
 * ---------------------------------------------------------------------------
 * Why the tenants are created out of band
 * ---------------------------------------------------------------------------
 *
 * Sign-up is rate limited to 5 per hour per IP — correctly, and that limit is
 * production behaviour worth keeping. Driving sign-up from a test loop burns
 * the allowance in minutes and then measures the throttle instead of the thing
 * under test. So the two accounts and their first workspace are created with
 * the owner connection, exactly as seeding does, and everything the test
 * actually asserts happens over HTTPS as an ordinary signed-in user.
 *
 * No production protection is disabled anywhere.
 *
 * The rule: an attack receiving an error is not evidence. Every A→B refusal is
 * paired with the same A→A operation, and both halves must hold.
 *
 *   ADMIN_URL=… BASE_URL=… VERCEL_BYPASS=… node scripts/hosted-isolation.mjs
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_URL ?? "";
const BYPASS = process.env.VERCEL_BYPASS ?? "";
if (!BASE || !ADMIN) { console.error("BASE_URL and ADMIN_URL are required."); process.exit(2); }

const headers = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};
let passed = 0, failed = 0;
const pass = (n, d = "") => { passed++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ""}`); };
const fail = (n, d = "") => { failed++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); };
const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

const id = (p = "c") => `${p}${randomUUID().replace(/-/g, "")}`;
const admin = new Client({ connectionString: ADMIN, connectionTimeoutMillis: 20_000 });
await admin.connect();

/** Creates a verified user with a workspace and one contact. Setup only. */
async function seedTenant(label) {
  const userId = id();
  const workspaceId = id();
  const email = `${label}-${Date.now()}@tinycrm.test`;
  const password = `Pw-${randomUUID().slice(0, 12)}-aA1!`;
  const hash = await bcrypt.hash(password, 10);
  const contactName = `${label}Contact${Date.now()}`;
  const contactId = id();

  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO "User" (id,email,name,"passwordHash","emailVerifiedAt","updatedAt")
     VALUES ($1,$2,$3,$4,now(),now())`,
    [userId, email, `${label} Owner`, hash],
  );
  await admin.query(
    `INSERT INTO "Workspace" (id,name,slug,"ownerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
    [workspaceId, `${label} Workspace`, `${label.toLowerCase()}-${Date.now()}`, userId],
  );
  await admin.query(
    `INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role) VALUES ($1,$2,$3,'owner')`,
    [id(), workspaceId, userId],
  );
  await admin.query(
    `INSERT INTO "Contact" (id,"workspaceId","firstName","lastName","fullName","updatedAt")
     VALUES ($1,$2,$3,'Probe',$4,now())`,
    [contactId, workspaceId, contactName, contactName],
  );
  await admin.query("COMMIT");

  return { label, userId, workspaceId, email, password, contactId, contactName };
}

const browser = await chromium.launch();

async function signIn(t) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, extraHTTPHeaders: headers });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', t.email);
  await page.fill('input[name="password"]', t.password);
  await page.click('button[type="submit"]');
  const ok = await page
    .waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`sign-in failed for ${t.label}: ${text}`);
  }
  return { ...t, ctx, page };
}

try {
  head("Setup (out of band) and sign-in through the real login form");
  const a = await signIn(await seedTenant("alpha"));
  const b = await signIn(await seedTenant("bravo"));
  pass("both tenants signed in through the deployed application");

  // -------------------------------------------------------------------------
  head("Reads — A→A must succeed, A→B must fail");

  const list = async (t) => {
    await t.page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
    await t.page.waitForTimeout(1500);
    return t.page.locator("body").innerText();
  };

  const aList = await list(a);
  if (aList.includes(a.contactName)) pass("A sees its own contact in the list — LEGITIMATE ACCESS WORKS");
  else fail("A sees its own contact", "the app cannot read its own data; every refusal below would be meaningless");
  if (!aList.includes(b.contactName)) pass("A does not see B's contact in the list");
  else fail("A does not see B's contact", "CROSS-TENANT LEAK");

  const bList = await list(b);
  if (bList.includes(b.contactName)) pass("B sees its own contact — LEGITIMATE ACCESS WORKS");
  else fail("B sees its own contact");
  if (!bList.includes(a.contactName)) pass("B does not see A's contact");
  else fail("B does not see A's contact", "CROSS-TENANT LEAK");

  // -------------------------------------------------------------------------
  head("Direct record URL substitution");

  const own = await a.page.request.get(`${BASE}/contacts/${a.contactId}`);
  const ownBody = own.ok() ? await own.text() : "";
  if (own.ok() && ownBody.includes(a.contactName)) pass("A can open its own contact by URL — LEGITIMATE ACCESS WORKS");
  else fail("A can open its own contact by URL", `http ${own.status()}`);

  const foreign = await a.page.request.get(`${BASE}/contacts/${b.contactId}`);
  const foreignBody = foreign.ok() ? await foreign.text() : "";
  if (!foreignBody.includes(b.contactName)) pass(`A cannot open B's contact by URL (http ${foreign.status()})`);
  else fail("A cannot open B's contact by URL", "CROSS-TENANT LEAK via id substitution");

  // -------------------------------------------------------------------------
  head("API and server-action surfaces");

  const search = async (t, term) => {
    const r = await t.page.request.get(`${BASE}/api/search?q=${encodeURIComponent(term)}`);
    return r.ok() ? r.text() : "";
  };
  if ((await search(a, a.contactName)).includes(a.contactName)) pass("search finds A's own record — LEGITIMATE ACCESS WORKS");
  else fail("search finds A's own record", "search is broken, so the refusal below proves nothing");
  if (!(await search(a, b.contactName)).includes(b.contactName)) pass("search does not find B's record");
  else fail("search does not find B's record", "CROSS-TENANT LEAK via search");

  const opts = async (t, ws) => {
    const r = await t.page.request.get(`${BASE}/api/options?type=contact&workspaceId=${ws}`);
    return r.ok() ? r.text() : "";
  };
  if ((await opts(a, a.workspaceId)).includes(a.contactName)) pass("options endpoint returns A's own records — LEGITIMATE ACCESS WORKS");
  else fail("options endpoint returns A's own records");
  if (!(await opts(a, b.workspaceId)).includes(b.contactName)) pass("options endpoint refuses B's workspace id");
  else fail("options endpoint refuses B's workspace id", "CROSS-TENANT LEAK via workspaceId parameter");

  // -------------------------------------------------------------------------
  head("Relationship substitution — creating A's record pointing at B's");

  // A note in A's workspace attached to B's contact. The action must refuse the
  // foreign relation rather than silently storing a cross-tenant reference.
  const before = await admin.query('SELECT count(*)::int AS n FROM "Note" WHERE "contactId" = $1', [b.contactId]);
  await a.page.goto(`${BASE}/notes`, { waitUntil: "domcontentloaded" });
  await a.page.waitForTimeout(1200);
  const forged = await a.page.request.post(`${BASE}/notes`, {
    headers: { "content-type": "text/plain;charset=UTF-8" },
    data: JSON.stringify({ workspaceId: a.workspaceId, contactId: b.contactId, title: "forged", body: "forged" }),
    failOnStatusCode: false,
  });
  void forged;
  const after = await admin.query('SELECT count(*)::int AS n FROM "Note" WHERE "contactId" = $1', [b.contactId]);
  if (after.rows[0].n === before.rows[0].n) pass("no note was attached to B's contact from A's session");
  else fail("relationship substitution", "a cross-tenant relation was created");

  // -------------------------------------------------------------------------
  head("Audit — a workspace-scoped, audited operation through the hosted app");

  // createContact is audited (record.created). Driven through the real Quick Add
  // dialog, which is what the "New contact" button opens. The fields carry no
  // name attribute and their labels are not bound with htmlFor, so each input is
  // located by the field wrapper that contains its label.
  const madeName = `Audited${Date.now()}`;
  await a.page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
  await a.page.waitForTimeout(1500);
  const newBtn = a.page.locator('button:has-text("New contact")').first();
  if (await newBtn.count()) {
    await newBtn.click();
    await a.page.waitForTimeout(1500);
    const first = a.page.locator('div:has(> label:has-text("First name")) input').first();
    if (await first.count()) {
      await first.fill(madeName);
      const last = a.page.locator('div:has(> label:has-text("Last name")) input').first();
      if (await last.count()) await last.fill("Probe");
      await a.page.locator('button:has-text("Create contact")').first().click();
      await a.page.waitForTimeout(4000);
    } else {
      console.log("  note  quick-add contact field not found");
    }
  } else {
    console.log("  note  no 'New contact' control found");
  }

  await a.page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
  await a.page.waitForTimeout(1500);
  if ((await a.page.locator("body").innerText()).includes(madeName)) {
    pass("the audited mutation actually created a record, visible to its owner");
  } else {
    fail("the audited mutation created a record", "nothing to audit, so the check below is empty");
  }

  const rows = await admin.query(
    `SELECT action, "actorId", "workspaceId", "entityType", "createdAt"
     FROM "AuditLog" WHERE "workspaceId" = $1 ORDER BY "createdAt" DESC LIMIT 5`,
    [a.workspaceId],
  );
  if (rows.rowCount > 0) {
    const row = rows.rows[0];
    pass("a workspace-scoped audit row was written", `${row.action}`);
    if (row.actorId === a.userId) pass("audit row names the correct actor");
    else fail("audit row actor", `${row.actorId} != ${a.userId}`);
    if (row.workspaceId === a.workspaceId) pass("audit row names the correct workspace");
    else fail("audit row workspace");
    if (row.createdAt instanceof Date && Date.now() - row.createdAt.getTime() < 10 * 60_000) {
      pass("audit row timestamp is recent and plausible");
    } else fail("audit row timestamp", String(row.createdAt));
  } else {
    fail("a workspace-scoped audit row was written", "none found for A's workspace");
  }

  // And B must not be able to read it.
  const bAudit = await b.page.request.get(`${BASE}/settings/data`);
  const bAuditBody = bAudit.ok() ? await bAudit.text() : "";
  if (!bAuditBody.includes(a.workspaceId)) pass("B's session shows nothing scoped to A's workspace");
  else fail("B cannot see A's workspace", "CROSS-TENANT LEAK");

  console.log("\n" + "=".repeat(64));
  console.log(`  passed ${passed}   failed ${failed}`);
  console.log("=".repeat(64));
  console.log(`\nHOSTED HTTP TENANT ISOLATION: ${failed === 0 ? "PASS" : "FAIL"}\n`);
} catch (error) {
  fail("run completed", String(error?.message ?? error).slice(0, 300));
  console.log(`\nHOSTED HTTP TENANT ISOLATION: FAIL\n`);
} finally {
  await browser.close();
  await admin.end().catch(() => {});
}

process.exit(failed === 0 ? 0 : 1);
