#!/usr/bin/env node
/**
 * The first restricted member, in production, under controlled conditions.
 *
 * Steps 3A, 3B and 4 built a boundary and proved it in CI. Nobody has ever
 * stood behind it in production: every membership there is `workspace` and
 * RecordGrant is empty. This harness creates one synthetic restricted principal
 * in a dedicated synthetic workspace, proves what it can and cannot reach
 * through the deployed application and through the deployed policies, and then
 * removes every trace of itself.
 *
 * ---------------------------------------------------------------------------
 * What this proves, and what it does not
 * ---------------------------------------------------------------------------
 *
 * PROVES, behaviourally, in production: the RLS record boundary (010/011/012),
 * grant enforcement and revocation latency, and the application's read paths
 * over real HTTPS with a real session.
 *
 * DOES NOT PROVE here: the Step 4 server-action guards — setMemberScope,
 * grantRecordAccess, revokeRecordAccess. There is no production UI through
 * which to invoke them, and this harness will not forge an identity to reach
 * them. Those guards remain CI-proven. Grants are therefore changed at the
 * database layer, as the workspace owner's session, which exercises 012's
 * administrator arm positively rather than bypassing it.
 *
 * ---------------------------------------------------------------------------
 * Safety
 * ---------------------------------------------------------------------------
 *
 * Nothing here runs by accident. There is no default action, no default
 * connection string, and no default target. Every phase must be named, the
 * production confirmation flag must be passed verbatim, and the expected
 * baseline must be asserted by the operator rather than discovered by the
 * script — a world that has changed shape since the runbook was approved
 * should stop the run, not be adopted by it.
 *
 * It refuses outright if any TEAM2_CANARY_* artifact already exists. It never
 * deletes one it did not create in this run without the operator looking first:
 * a leftover fixture means a previous run did not finish, and that is a
 * question for a person.
 *
 * Phases run in order and are gated on the recorded state, so none can be
 * skipped by accident. `cleanup` is reachable from every state after `create`,
 * including a failed verification — the one phase that must always be callable.
 *
 *   baseline   read-only; asserts the world matches the approved expectations
 *   create     synthetic users, workspace, fixture graph, restricted invitation
 *   accept     signs the canary in and redeems that invitation in a real
 *              browser, so the membership and its first grant are created by
 *              the deployed application rather than by this script
 *   verify     positive, negative and adversarial proofs
 *   lifecycle  grant, multi-anchor, revocation and restoration
 *   cleanup    removes everything, in dependency order, and re-asserts baseline
 *
 *   node scripts/canary-restricted-member.mjs <phase> --production-canary-confirmed \
 *     --expect-memberships=18 --expect-migrations=7 --canary-password='<>=16 chars>'
 *
 * Required environment (no defaults, deliberately):
 *   ADMIN_URL    unpooled owner connection — fixtures and cleanup
 *   APP_URL_DB   the tinycrm_app connection — every proof runs through this,
 *                because a proof run as the owner proves nothing: the owner
 *                bypasses row-level security
 *   BASE_URL     https origin of the deployed application
 *
 * Connection strings are never printed, logged or written to the state file.
 */

import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const PREFIX = "TEAM2_CANARY";
const EMAIL_PREFIX = "team2-canary";
const CONFIRM_FLAG = "--production-canary-confirmed";
const PHASES = ["baseline", "create", "accept", "verify", "lifecycle", "cleanup"];

// ---------------------------------------------------------------------------
// Argument and environment handling — fail closed, every time
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const phase = argv.find((a) => !a.startsWith("-")) ?? null;
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function usage(message) {
  if (message) console.error(`\n  ${message}\n`);
  console.error(
    `  usage: node scripts/canary-restricted-member.mjs <${PHASES.join("|")}> ${CONFIRM_FLAG} \\\n` +
      `           --expect-memberships=<n> --expect-migrations=<n> --canary-password=<>=16 chars>\n` +
      `           [--expect-release=<sha>] [--state=<path>]\n\n` +
      `  environment: ADMIN_URL, APP_URL_DB, BASE_URL (all required, no defaults)\n`,
  );
  process.exit(2);
}

if (!phase) usage("no phase given — this script does nothing unless told exactly what to do");
if (!PHASES.includes(phase)) usage(`unknown phase ${JSON.stringify(phase)}`);
if (!flag(CONFIRM_FLAG.slice(2))) {
  usage(`refusing to touch production without ${CONFIRM_FLAG}`);
}

const ADMIN_URL = process.env["ADMIN_URL"];
const APP_URL_DB = process.env["APP_URL_DB"];
const BASE_URL = process.env["BASE_URL"];

if (!ADMIN_URL || !/^postgres(ql)?:\/\//.test(ADMIN_URL)) {
  usage("ADMIN_URL must be set to a PostgreSQL connection string");
}
if (!APP_URL_DB || !/^postgres(ql)?:\/\//.test(APP_URL_DB)) {
  usage("APP_URL_DB must be set to the tinycrm_app PostgreSQL connection string");
}
if (!BASE_URL || !/^https:\/\//.test(BASE_URL)) {
  usage("BASE_URL must be set to an https origin");
}
if (ADMIN_URL === APP_URL_DB) {
  usage("ADMIN_URL and APP_URL_DB are the same connection — every proof would run as the owner and be vacuous");
}

// Read as text first. `Number(null)` is 0, and 0 is an integer — so testing the
// converted value would have accepted a *missing* flag as "expect zero", which
// is a safeguard that fails open. The flag must be present and must parse.
const rawMemberships = value("expect-memberships");
const rawMigrations = value("expect-migrations");
if (rawMemberships === null || rawMigrations === null) {
  usage("--expect-memberships and --expect-migrations are required: the baseline is asserted, not discovered");
}
const EXPECT_MEMBERSHIPS = Number(rawMemberships);
const EXPECT_MIGRATIONS = Number(rawMigrations);
const EXPECT_RELEASE = value("expect-release");
if (!Number.isInteger(EXPECT_MEMBERSHIPS) || EXPECT_MEMBERSHIPS <= 0) {
  usage(`--expect-memberships must be a positive integer, got ${JSON.stringify(rawMemberships)}`);
}
if (!Number.isInteger(EXPECT_MIGRATIONS) || EXPECT_MIGRATIONS <= 0) {
  usage(`--expect-migrations must be a positive integer, got ${JSON.stringify(rawMigrations)}`);
}

const STATE_PATH = value("state") ?? resolve(tmpdir(), "team2-canary-state.json");

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;
const pass = (name, detail = "") => console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail = "") => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
const check = (name, ok, detail = "") => (ok ? pass(name, detail) : fail(name, detail));
const section = (title) => console.log(`\n${title}`);

/** Stops the run immediately. Used for conditions that make continuing unsafe. */
class Halt extends Error {}
const halt = (why) => {
  throw new Halt(why);
};

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * TLS follows the connection string rather than being hardcoded.
 *
 * Every hosted URL this is meant for carries `sslmode=require`; a local cluster
 * carries none and does not speak TLS at all. Reading the mode from the URL
 * means a dry run against a local database exercises the same code path,
 * without a flag that could later be pointed at production to turn TLS off.
 */
const connect = async (url) => {
  const encrypted = /[?&]sslmode=(require|verify-ca|verify-full|prefer)/.test(url);
  const client = new Client({
    connectionString: url,
    ssl: encrypted ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  return client;
};

/** Runs one unit of work as a given principal through the application role. */
async function asPrincipal(app, { workspaceId, userId, restricted }, fn) {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.workspace_ids', $1, true)", [workspaceId ?? ""]);
    await app.query("SELECT set_config('app.user_id', $1, true)", [userId ?? ""]);
    await app.query("SELECT set_config('app.restricted_workspace_ids', $1, true)", [
      restricted ? workspaceId : "",
    ]);
    return await fn();
  } finally {
    // Always. A proof that writes is a proof that must leave nothing behind.
    await app.query("ROLLBACK");
  }
}

/**
 * An attempted write that must be refused *with an error*.
 *
 * Only correct for INSERT. A WITH CHECK violation raises; a USING violation
 * does not — PostgreSQL filters the rows an UPDATE or DELETE can see and
 * reports zero affected, silently. Asserting "it threw" for those would have
 * called a working policy broken, which is how the first local run of this
 * harness read before `mustNotModify` existed.
 */
async function mustRefuse(app, principal, sql, params, name) {
  let refused = false;
  let detail = "";
  await asPrincipal(app, principal, async () => {
    try {
      await app.query(sql, params);
    } catch (error) {
      refused = true;
      detail = String(error.message).split("\n")[0].slice(0, 120);
    }
  });
  check(name, refused, refused ? detail : "THE WRITE WAS ACCEPTED");
}

/**
 * An attempted write that must affect no rows.
 *
 * The right shape for UPDATE and DELETE under row-level security: the policy
 * does not raise, it narrows what the statement can see to nothing. A non-zero
 * row count is the failure, and it is reported with the count so the size of
 * the hole is visible rather than merely its existence.
 */
async function mustNotModify(app, principal, sql, params, name) {
  let affected = -1;
  let raised = "";
  await asPrincipal(app, principal, async () => {
    try {
      affected = (await app.query(sql, params)).rowCount;
    } catch (error) {
      affected = 0;
      raised = String(error.message).split("\n")[0].slice(0, 100);
    }
  });
  check(name, affected === 0, raised || (affected === 0 ? "0 rows" : `${affected} ROW(S) MODIFIED`));
}

// ---------------------------------------------------------------------------
// State, carried between phases
// ---------------------------------------------------------------------------

const loadState = () => {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
};

/**
 * The state file carries the invitation token in plaintext.
 *
 * It has to: the accept phase opens the link the way a person would, and the
 * token is not recoverable from the row, only its SHA-256 is stored. It is a
 * single-use invitation into a synthetic workspace, it expires in two hours,
 * and the file is written with owner-only permissions under the system
 * temporary directory. Connection strings are still never written here.
 */
const saveState = (state) =>
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/** Every table that carries a workspaceId and could hold a stray fixture. */
const SWEEP_TABLES = [
  "Workspace", "Contact", "Company", "Opportunity", "Project", "Deal", "Task",
  "Note", "Activity", "FileAsset", "Milestone", "Tag", "AiInsight", "AiThread",
];
// Verified against information_schema rather than assumed: Activity and Note
// carry `title`, not `subject`, and Contact's display column is `fullName`. A
// sweep that queries a column which does not exist throws instead of reporting
// residue, which is the wrong direction for a cleanup check to fail in.
const SWEEP_COLUMN = {
  Workspace: "name", Contact: "fullName", Company: "name", Opportunity: "name",
  Project: "name", Deal: "name", Task: "title", Note: "title", Activity: "title",
  FileAsset: "name", Milestone: "name", Tag: "name", AiInsight: "title", AiThread: "title",
};

async function residualCount(admin) {
  let total = 0;
  const found = [];
  for (const table of SWEEP_TABLES) {
    const column = SWEEP_COLUMN[table];
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" LIKE $1`,
      [`${PREFIX}%`],
    );
    if (rows[0].n > 0) found.push(`${table}=${rows[0].n}`);
    total += rows[0].n;
  }
  const users = await admin.query(`SELECT count(*)::int AS n FROM "User" WHERE email LIKE $1`, [
    `${EMAIL_PREFIX}%`,
  ]);
  if (users.rows[0].n > 0) found.push(`User=${users.rows[0].n}`);
  return { total: total + users.rows[0].n, found };
}

async function captureBaseline(admin) {
  const one = async (sql) => (await admin.query(sql)).rows[0];
  const users = (await one(`SELECT count(*)::int AS n FROM "User"`)).n;
  const workspaces = (await one(`SELECT count(*)::int AS n FROM "Workspace"`)).n;
  const members = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE "scopeMode"='workspace')::int AS ws,
            count(*) FILTER (WHERE "scopeMode"='restricted')::int AS restricted
     FROM "WorkspaceMember"`,
  );
  const grants = (await one(`SELECT count(*)::int AS n FROM "RecordGrant"`)).n;
  const audit = (await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "workspaceId" IS NULL`)).n;
  const migrations = (await one(
    `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
  )).n;
  const fks = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT condeferrable)::int AS nd
     FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`,
  );
  const residual = await residualCount(admin);

  const health = await fetch(`${BASE_URL}/api/health`).then(
    async (r) => ({ status: r.status, body: await r.json().catch(() => null) }),
    () => ({ status: 0, body: null }),
  );
  const ready = await fetch(`${BASE_URL}/api/ready`).then(
    (r) => r.status,
    () => 0,
  );

  return { users, workspaces, members, grants, audit, migrations, fks, residual, health, ready };
}

function reportBaseline(b) {
  section("[baseline] production, immediately before any change");
  console.log(`          users ${b.users} · workspaces ${b.workspaces} · memberships ${b.members.total}`);
  console.log(`          scope modes: workspace ${b.members.ws} · restricted ${b.members.restricted}`);
  console.log(`          RecordGrant ${b.grants} · null-workspace AuditLog ${b.audit}`);
  console.log(`          migrations ${b.migrations} · foreign keys ${b.fks.total} (${b.fks.nd} non-deferrable)`);
  console.log(`          release ${b.health.body?.release ?? "unknown"}`);

  check(`/api/health 200`, b.health.status === 200, String(b.health.status));
  check(`/api/ready 200`, b.ready === 200, String(b.ready));
  check(`memberships = ${EXPECT_MEMBERSHIPS}`, b.members.total === EXPECT_MEMBERSHIPS, String(b.members.total));
  check(`all memberships workspace-scoped`, b.members.ws === b.members.total && b.members.restricted === 0);
  check(`RecordGrant empty`, b.grants === 0, String(b.grants));
  check(`migrations = ${EXPECT_MIGRATIONS}`, b.migrations === EXPECT_MIGRATIONS, String(b.migrations));
  check(`0 non-deferrable foreign keys`, b.fks.nd === 0, `${b.fks.nd} of ${b.fks.total}`);
  check(`no pre-existing ${PREFIX}_* artifacts`, b.residual.total === 0,
    b.residual.total === 0 ? "" : b.residual.found.join(", "));
  if (EXPECT_RELEASE) {
    check(`release = ${EXPECT_RELEASE}`, b.health.body?.release === EXPECT_RELEASE,
      b.health.body?.release ?? "unknown");
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** Phase ordering. Cleanup is reachable from every state after create. */
const ORDER = ["created", "accepted", "verified", "exercised"];
const atLeast = (state, phaseName) =>
  state && ORDER.indexOf(state.phase) >= ORDER.indexOf(phaseName);

const id = (p) => `${p}${randomBytes(12).toString("hex")}`;
const now = () => new Date();

/**
 * Sentinels.
 *
 * Sensitive company fields are filled with strings that appear nowhere else in
 * the world, so "the restricted member did not receive the revenue band" is a
 * substring search with a definite answer rather than a judgement about which
 * of several plausible renderings counts.
 */
const SENTINEL = {
  revenue: `${PREFIX}_SENTINEL_REVENUE_BAND`,
  description: `${PREFIX}_SENTINEL_ACCOUNT_NOTE`,
  leadSource: `${PREFIX}_SENTINEL_LEAD_SOURCE`,
  relationship: `${PREFIX}_SENTINEL_RELATIONSHIP`,
  brief: `${PREFIX}_SENTINEL_OWNER_BRIEF_BODY`,
  message: `${PREFIX}_SENTINEL_OWNER_MESSAGE`,
};

// ---------------------------------------------------------------------------
// HTTP, as a real signed-in person
// ---------------------------------------------------------------------------

/** A cookie jar small enough to read, which is the point. */
function jar() {
  const store = new Map();
  return {
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    has(name) {
      return [...store.keys()].some((k) => k.endsWith(name));
    },
  };
}

/**
 * Signs in the way a browser does: CSRF token, then the credentials callback.
 *
 * Deliberately once per identity per phase — sign-in is rate limited to five
 * attempts per account per fifteen minutes, and a retry loop here would lock
 * the canary out of its own test.
 */
async function signIn(email, password) {
  const cookies = jar();
  const csrfResponse = await fetch(`${BASE_URL}/api/auth/csrf`, { redirect: "manual" });
  cookies.absorb(csrfResponse);
  const { csrfToken } = await csrfResponse.json();

  const body = new URLSearchParams({
    email, password, csrfToken, callbackUrl: `${BASE_URL}/home`,
  });
  const response = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
      cookie: cookies.header(),
    },
    body,
  });
  cookies.absorb(response);

  if (!cookies.has("authjs.session-token")) {
    halt(`sign-in did not produce a session for ${email} — every authorize() rejection looks the same, so check the password, the lockout window and the five-attempt limit`);
  }
  return cookies;
}

/** Fetches a page as the signed-in person and returns its status and body. */
async function page(cookies, path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    headers: { cookie: cookies.header() },
  });
  const text = response.status === 200 ? await response.text() : "";
  return { status: response.status, text };
}

/** True when a page renders a name; the assertion both directions rely on. */
async function shows(cookies, path, needle) {
  const { status, text } = await page(cookies, path);
  return status === 200 && text.includes(needle);
}

async function apiJson(cookies, path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { cookie: cookies.header() },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// Phase: baseline
// ---------------------------------------------------------------------------

async function runBaseline() {
  const admin = await connect(ADMIN_URL);
  try {
    reportBaseline(await captureBaseline(admin));
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// Phase: create
// ---------------------------------------------------------------------------

async function runCreate() {
  const admin = await connect(ADMIN_URL);
  try {
    const baseline = await captureBaseline(admin);
    reportBaseline(baseline);
    if (failures > 0) halt("baseline did not match the approved expectations — nothing was created");
    if (baseline.residual.total > 0) {
      halt(
        `${PREFIX}_* artifacts already exist (${baseline.residual.found.join(", ")}). ` +
          `A previous run did not finish. Inspect them; this script will not remove what it did not create.`,
      );
    }
    if (existsSync(STATE_PATH)) {
      halt(`a state file already exists at ${STATE_PATH} — resolve the previous run before starting another`);
    }

    const password = value("canary-password");
    if (!password || password.length < 16) {
      halt("--canary-password=<at least 16 characters> is required; the canary signs in for real");
    }
    const hash = bcrypt.hashSync(password, 12);
    const emailFor = (who) => `${EMAIL_PREFIX}-${who}-${randomBytes(4).toString("hex")}@example.invalid`;

    section("[create] synthetic identities and workspace");
    const s = { phase: "created", createdAt: now().toISOString() };

    s.ownerUserId = id("u");
    s.canaryUserId = id("u");
    s.otherUserId = id("u");
    s.ownerEmail = emailFor("owner");
    s.canaryEmail = emailFor("member");
    s.otherEmail = emailFor("other");

    for (const [uid, email, name] of [
      [s.ownerUserId, s.ownerEmail, `${PREFIX}_OWNER`],
      [s.canaryUserId, s.canaryEmail, `${PREFIX}_MEMBER`],
      [s.otherUserId, s.otherEmail, `${PREFIX}_OTHER`],
    ]) {
      await admin.query(
        `INSERT INTO "User"(id,email,name,"passwordHash","emailVerifiedAt","onboardedAt","updatedAt")
         VALUES ($1,$2,$3,$4,now(),now(),now())`,
        [uid, email, name, hash],
      );
    }
    console.log(`  created 3 users (${PREFIX}_OWNER, _MEMBER, _OTHER)`);

    s.workspaceId = id("w");
    await admin.query(
      `INSERT INTO "Workspace"(id,name,slug,"ownerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.workspaceId, `${PREFIX}_WS`, `team2-canary-${randomBytes(4).toString("hex")}`, s.ownerUserId],
    );
    s.ownerMembershipId = id("m");
    await admin.query(
      `INSERT INTO "WorkspaceMember"(id,"workspaceId","userId",role,"scopeMode")
       VALUES ($1,$2,$3,'owner','workspace')`,
      [s.ownerMembershipId, s.workspaceId, s.ownerUserId],
    );

    // Supporting rows the anchors and the deal require.
    s.statusId = id("ps");
    await admin.query(
      `INSERT INTO "ProjectStatus"(id,"workspaceId",name,key,"order") VALUES ($1,$2,'Active','active',0)`,
      [s.statusId, s.workspaceId],
    );
    s.pipelineId = id("pl");
    await admin.query(`INSERT INTO "Pipeline"(id,"workspaceId",name) VALUES ($1,$2,$3)`,
      [s.pipelineId, s.workspaceId, `${PREFIX}_PIPELINE`]);
    s.stageId = id("st");
    await admin.query(`INSERT INTO "PipelineStage"(id,"pipelineId",name,"order") VALUES ($1,$2,'Open',0)`,
      [s.stageId, s.pipelineId]);

    section("[create] the fixture graph");
    s.companyVisibleId = id("co");
    await admin.query(
      `INSERT INTO "Company"(id,"workspaceId",name,"revenueRange",description,"leadSource",
                             "relationshipStatus","ownerId","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [s.companyVisibleId, s.workspaceId, `${PREFIX}_CO_VISIBLE`, SENTINEL.revenue,
       SENTINEL.description, SENTINEL.leadSource, SENTINEL.relationship, s.ownerUserId],
    );
    s.companyHiddenId = id("co");
    await admin.query(`INSERT INTO "Company"(id,"workspaceId",name,"updatedAt") VALUES ($1,$2,$3,now())`,
      [s.companyHiddenId, s.workspaceId, `${PREFIX}_CO_HIDDEN`]);

    s.grantedOppId = id("o");
    await admin.query(
      `INSERT INTO "Opportunity"(id,"workspaceId",name,"companyId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.grantedOppId, s.workspaceId, `${PREFIX}_OPP_GRANTED`, s.companyVisibleId],
    );
    s.ungrantedOppId = id("o");
    await admin.query(
      `INSERT INTO "Opportunity"(id,"workspaceId",name,"companyId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.ungrantedOppId, s.workspaceId, `${PREFIX}_OPP_UNGRANTED`, s.companyHiddenId],
    );
    s.grantedProjectId = id("p");
    await admin.query(
      `INSERT INTO "Project"(id,"workspaceId",name,"statusId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.grantedProjectId, s.workspaceId, `${PREFIX}_PROJ_GRANTED`, s.statusId],
    );
    s.ungrantedProjectId = id("p");
    await admin.query(
      `INSERT INTO "Project"(id,"workspaceId",name,"statusId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.ungrantedProjectId, s.workspaceId, `${PREFIX}_PROJ_UNGRANTED`, s.statusId],
    );

    s.contactReachableId = id("c");
    await admin.query(
      `INSERT INTO "Contact"(id,"workspaceId","firstName","lastName","fullName","updatedAt")
       VALUES ($1,$2,$3,'REACHABLE',$4,now())`,
      [s.contactReachableId, s.workspaceId, `${PREFIX}_CONTACT`, `${PREFIX}_CONTACT_REACHABLE`],
    );
    s.contactHiddenId = id("c");
    await admin.query(
      `INSERT INTO "Contact"(id,"workspaceId","firstName","lastName","fullName","updatedAt")
       VALUES ($1,$2,$3,'HIDDEN',$4,now())`,
      [s.contactHiddenId, s.workspaceId, `${PREFIX}_CONTACT`, `${PREFIX}_CONTACT_HIDDEN`],
    );
    await admin.query(`INSERT INTO "OpportunityContact"("opportunityId","contactId") VALUES ($1,$2)`,
      [s.grantedOppId, s.contactReachableId]);
    await admin.query(`INSERT INTO "OpportunityContact"("opportunityId","contactId") VALUES ($1,$2)`,
      [s.ungrantedOppId, s.contactHiddenId]);

    // Step 3A children, one per rule.
    const task = async (key, label, oppId, projectId) => {
      s[key] = id("t");
      await admin.query(
        `INSERT INTO "Task"(id,"workspaceId",title,"opportunityId","projectId","updatedAt")
         VALUES ($1,$2,$3,$4,$5,now())`,
        [s[key], s.workspaceId, `${PREFIX}_${label}`, oppId, projectId],
      );
    };
    await task("taskOnGrantedOppId", "TASK_ON_GRANTED_OPP", s.grantedOppId, null);
    await task("taskOnUngrantedOppId", "TASK_ON_UNGRANTED_OPP", s.ungrantedOppId, null);
    await task("taskDualId", "TASK_DUAL", s.grantedOppId, s.ungrantedProjectId);
    await task("taskUnanchoredId", "TASK_UNANCHORED", null, null);

    s.noteOnGrantedOppId = id("n");
    await admin.query(
      `INSERT INTO "Note"(id,"workspaceId",title,"opportunityId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.noteOnGrantedOppId, s.workspaceId, `${PREFIX}_NOTE_ON_GRANTED_OPP`, s.grantedOppId],
    );
    s.activityOnGrantedOppId = id("a");
    await admin.query(
      `INSERT INTO "Activity"(id,"workspaceId",type,title,"opportunityId") VALUES ($1,$2,'note',$3,$4)`,
      [s.activityOnGrantedOppId, s.workspaceId, `${PREFIX}_ACTIVITY_ON_GRANTED_OPP`, s.grantedOppId],
    );
    s.milestoneGrantedId = id("ms");
    await admin.query(`INSERT INTO "Milestone"(id,"projectId",name) VALUES ($1,$2,$3)`,
      [s.milestoneGrantedId, s.grantedProjectId, `${PREFIX}_MILESTONE_GRANTED`]);
    s.milestoneUngrantedId = id("ms");
    await admin.query(`INSERT INTO "Milestone"(id,"projectId",name) VALUES ($1,$2,$3)`,
      [s.milestoneUngrantedId, s.ungrantedProjectId, `${PREFIX}_MILESTONE_UNGRANTED`]);

    // A deal on work the canary will hold: Deal denial has to bite even then.
    s.dealId = id("d");
    await admin.query(
      `INSERT INTO "Deal"(id,"workspaceId",name,"pipelineId","stageId","projectId","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [s.dealId, s.workspaceId, `${PREFIX}_DEAL`, s.pipelineId, s.stageId, s.grantedProjectId],
    );

    // S7 fixtures: output belonging to somebody else, and to the canary.
    s.ownerInsightId = id("ai");
    await admin.query(
      `INSERT INTO "AiInsight"(id,"workspaceId","userId",kind,"entityType","entityId",title,body)
       VALUES ($1,$2,$3,'brief','workspace',$2,$4,$5)`,
      [s.ownerInsightId, s.workspaceId, s.ownerUserId, `${PREFIX}_OWNER_BRIEF`, SENTINEL.brief],
    );
    s.canaryInsightId = id("ai");
    await admin.query(
      `INSERT INTO "AiInsight"(id,"workspaceId","userId",kind,"entityType","entityId",title,body)
       VALUES ($1,$2,$3,'brief','workspace',$2,$4,'Visible to the canary')`,
      [s.canaryInsightId, s.workspaceId, s.canaryUserId, `${PREFIX}_CANARY_BRIEF`],
    );
    s.ownerThreadId = id("th");
    await admin.query(
      `INSERT INTO "AiThread"(id,"workspaceId","userId",title,"updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [s.ownerThreadId, s.workspaceId, s.ownerUserId, `${PREFIX}_OWNER_THREAD`],
    );
    s.ownerMessageId = id("msg");
    await admin.query(
      `INSERT INTO "AiMessage"(id,"threadId","userId",role,content) VALUES ($1,$2,$3,'user',$4)`,
      [s.ownerMessageId, s.ownerThreadId, s.ownerUserId, SENTINEL.message],
    );

    // A second restricted member, holding a grant the canary must not see.
    s.otherMembershipId = id("m");
    await admin.query(
      `INSERT INTO "WorkspaceMember"(id,"workspaceId","userId",role,"scopeMode")
       VALUES ($1,$2,$3,'member','restricted')`,
      [s.otherMembershipId, s.workspaceId, s.otherUserId],
    );
    s.otherGrantId = id("g");
    await admin.query(
      `INSERT INTO "RecordGrant"(id,"workspaceId","userId","membershipId","anchorType","anchorId","grantedById")
       VALUES ($1,$2,$3,$4,'opportunity',$5,$6)`,
      [s.otherGrantId, s.workspaceId, s.otherUserId, s.otherMembershipId, s.ungrantedOppId, s.ownerUserId],
    );
    console.log(`  created the fixture graph and a second restricted member`);

    // The invitation the canary will redeem through the deployed application.
    // Only the hash is stored, exactly as issueInvitation does; the plaintext
    // lives in the local state file because the accept phase needs the link.
    s.invitationToken = randomBytes(32).toString("base64url");
    s.invitationId = id("inv");
    await admin.query(
      `INSERT INTO "WorkspaceInvitation"(id,"workspaceId","invitedById",email,role,"scopeMode",scope,
                                         "tokenHash","expiresAt","updatedAt")
       VALUES ($1,$2,$3,$4,'member','restricted',$5,$6,now() + interval '2 hours',now())`,
      [s.invitationId, s.workspaceId, s.ownerUserId, s.canaryEmail,
       JSON.stringify([{ entityType: "opportunity", entityId: s.grantedOppId }]),
       createHash("sha256").update(s.invitationToken).digest("hex")],
    );
    console.log(`  issued a restricted invitation naming ${PREFIX}_OPP_GRANTED`);

    saveState(s);
    section("[create] state");
    console.log(`  workspace ${s.workspaceId}`);
    console.log(`  state file ${STATE_PATH}`);
    check("the canary has no membership yet", true, "it is created by accepting the invitation");
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// Phase: accept — the deployed invitation path, in a real browser
// ---------------------------------------------------------------------------

async function runAccept() {
  const s = loadState();
  if (!s) halt(`no state file at ${STATE_PATH} — run create first`);
  if (s.phase !== "created") halt(`expected phase "created", found ${JSON.stringify(s.phase)}`);

  const password = value("canary-password");
  if (!password) halt("--canary-password is required to sign the canary in");

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const admin = await connect(ADMIN_URL);
  try {
    const context = await browser.newContext();
    const view = await context.newPage();

    section("[accept] signing in as the canary and redeeming the invitation");
    await view.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await view.waitForSelector("#password", { timeout: 60_000 });
    await view.waitForTimeout(750);
    await view.fill("#email", s.canaryEmail);
    await view.fill("#password", password);
    await view.getByRole("button", { name: "Sign in", exact: true }).click();
    await view.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });

    await view.goto(`${BASE_URL}/invite/${encodeURIComponent(s.invitationToken)}`, {
      waitUntil: "domcontentloaded", timeout: 60_000,
    });
    const join = view.getByRole("button", { name: new RegExp(`^Join ${PREFIX}_WS`) });
    await join.waitFor({ timeout: 60_000 });
    await view.waitForTimeout(750);
    await join.click();
    await view.waitForURL((url) => !url.pathname.startsWith("/invite"), { timeout: 60_000 });

    section("[accept] what the deployed application actually wrote");
    const membership = (await admin.query(
      `SELECT id, role, "scopeMode" FROM "WorkspaceMember" WHERE "workspaceId"=$1 AND "userId"=$2`,
      [s.workspaceId, s.canaryUserId],
    )).rows[0];
    check("a membership was created", Boolean(membership));
    check("it is restricted", membership?.scopeMode === "restricted", membership?.scopeMode ?? "none");
    check("it carries the invited role", membership?.role === "member", membership?.role ?? "none");

    const grants = (await admin.query(
      `SELECT "anchorType","anchorId","membershipId" FROM "RecordGrant" WHERE "workspaceId"=$1 AND "userId"=$2`,
      [s.workspaceId, s.canaryUserId],
    )).rows;
    check("exactly one grant was materialized", grants.length === 1, `${grants.length}`);
    check("it names the invited opportunity",
      grants[0]?.anchorId === s.grantedOppId && grants[0]?.anchorType === "opportunity");
    check("the grant belongs to the new membership", grants[0]?.membershipId === membership?.id);

    const invitation = (await admin.query(
      `SELECT "acceptedAt","acceptedByUserId" FROM "WorkspaceInvitation" WHERE id=$1`, [s.invitationId],
    )).rows[0];
    check("the invitation was claimed", Boolean(invitation?.acceptedAt));
    check("claimed by the canary", invitation?.acceptedByUserId === s.canaryUserId);

    if (failures === 0) {
      s.canaryMembershipId = membership.id;
      s.phase = "accepted";
      saveState(s);
    }
  } finally {
    await admin.end();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Phase: verify
// ---------------------------------------------------------------------------

async function runVerify() {
  const s = loadState();
  if (!atLeast(s, "accepted")) halt("run the accept phase first — there is no restricted principal yet");

  const password = value("canary-password");
  if (!password) halt("--canary-password is required");

  const app = await connect(APP_URL_DB);
  try {
    const canary = { workspaceId: s.workspaceId, userId: s.canaryUserId, restricted: true };
    const cookies = await signIn(s.canaryEmail, password);

    section("[verify] positive — the work the canary was given");
    check("the granted opportunity renders by exact id",
      await shows(cookies, `/opportunities/${s.grantedOppId}`, `${PREFIX}_OPP_GRANTED`));
    check("the contact on granted work renders by exact id",
      await shows(cookies, `/contacts/${s.contactReachableId}`, `${PREFIX}_CONTACT_REACHABLE`));
    check("the company behind granted work renders by exact id",
      await shows(cookies, `/companies/${s.companyVisibleId}`, `${PREFIX}_CO_VISIBLE`));
    check("its own AI brief is readable",
      await shows(cookies, `/ai`, `${PREFIX}_CANARY_BRIEF`));

    await asPrincipal(app, canary, async () => {
      const rows = async (sql, p) => (await app.query(sql, p)).rows;
      const opp = await rows(`SELECT id FROM "Opportunity"`);
      check("sees exactly the granted opportunity",
        opp.length === 1 && opp[0].id === s.grantedOppId, `${opp.length} visible`);
      const children = await rows(`SELECT id FROM "Task" WHERE id = ANY($1::text[])`,
        [[s.taskOnGrantedOppId, s.taskOnUngrantedOppId, s.taskDualId, s.taskUnanchoredId]]);
      const seen = new Set(children.map((r) => r.id));
      check("the task on granted work is visible", seen.has(s.taskOnGrantedOppId));
      check("its own grant rows are readable",
        (await rows(`SELECT id FROM "RecordGrant"`)).length > 0);
    });

    section("[verify] negative — by exact id, not merely absent from a list");
    const hiddenPages = [
      [`/opportunities/${s.ungrantedOppId}`, `${PREFIX}_OPP_UNGRANTED`, "an ungranted opportunity"],
      [`/projects/${s.ungrantedProjectId}`, `${PREFIX}_PROJ_UNGRANTED`, "an ungranted project"],
      [`/contacts/${s.contactHiddenId}`, `${PREFIX}_CONTACT_HIDDEN`, "a contact on ungranted work"],
      [`/companies/${s.companyHiddenId}`, `${PREFIX}_CO_HIDDEN`, "a company on ungranted work"],
      [`/deals/${s.dealId}`, `${PREFIX}_DEAL`, "a deal on work it holds"],
    ];
    for (const [path, needle, label] of hiddenPages) {
      check(`${label} is not reachable`, !(await shows(cookies, path, needle)));
    }

    const visible = await page(cookies, `/companies/${s.companyVisibleId}`);
    for (const [name, sentinel] of Object.entries({
      "revenue band": SENTINEL.revenue, "account note": SENTINEL.description,
      "lead source": SENTINEL.leadSource, "relationship status": SENTINEL.relationship,
    })) {
      check(`the company's ${name} is withheld`, !visible.text.includes(sentinel));
    }

    const ai = await page(cookies, `/ai`);
    check("another person's brief body is not rendered", !ai.text.includes(SENTINEL.brief));
    check("another person's message is not rendered", !ai.text.includes(SENTINEL.message));

    section("[verify] negative — enumeration surfaces");
    const options = await apiJson(cookies, `/api/options?type=contact`);
    const optionValues = (options.body?.options ?? []).map((o) => o.value);
    check("/api/options offers the reachable contact", optionValues.includes(s.contactReachableId));
    check("/api/options hides the unreachable contact", !optionValues.includes(s.contactHiddenId));
    const search = await apiJson(cookies, `/api/search?q=${PREFIX}`);
    const hits = JSON.stringify(search.body ?? {});
    check("search does not surface ungranted work", !hits.includes(s.ungrantedOppId));
    check("search does not surface the hidden contact", !hits.includes(s.contactHiddenId));
    check("search does not surface any deal", !hits.includes(s.dealId));

    section("[verify] negative — the database, as the canary");
    await asPrincipal(app, canary, async () => {
      const rows = async (sql, p) => (await app.query(sql, p)).rows;
      check("no deal is visible", (await rows(`SELECT id FROM "Deal"`)).length === 0);
      check("the ungranted project is invisible",
        (await rows(`SELECT id FROM "Project" WHERE id=$1`, [s.ungrantedProjectId])).length === 0);
      check("the dual-anchored task is invisible while one anchor is ungranted",
        (await rows(`SELECT id FROM "Task" WHERE id=$1`, [s.taskDualId])).length === 0);
      check("the unanchored task is invisible",
        (await rows(`SELECT id FROM "Task" WHERE id=$1`, [s.taskUnanchoredId])).length === 0);
      check("a child of ungranted work is invisible",
        (await rows(`SELECT id FROM "Task" WHERE id=$1`, [s.taskOnUngrantedOppId])).length === 0);
      check("a milestone on an ungranted project is invisible",
        (await rows(`SELECT id FROM "Milestone" WHERE id=$1`, [s.milestoneUngrantedId])).length === 0);
      const foreign = await rows(`SELECT id FROM "RecordGrant" WHERE "userId" <> $1`, [s.canaryUserId]);
      check("another member's grants are not selectable", foreign.length === 0, `${foreign.length}`);
      const insights = await rows(`SELECT id FROM "AiInsight" WHERE "userId" <> $1`, [s.canaryUserId]);
      check("another person's AI insight is not selectable", insights.length === 0);
      const messages = await rows(`SELECT id FROM "AiMessage" WHERE id=$1`, [s.ownerMessageId]);
      check("another person's AI message is not selectable", messages.length === 0);
    });

    section("[verify] adversarial — 012, behaviourally, in production");
    await mustRefuse(app, canary,
      `INSERT INTO "RecordGrant"(id,"workspaceId","userId","membershipId","anchorType","anchorId")
       VALUES ($1,$2,$3,$4,'opportunity',$5)`,
      [id("g"), s.workspaceId, s.canaryUserId, s.canaryMembershipId, s.ungrantedOppId],
      "a restricted member cannot grant itself an unseen opportunity");
    await mustNotModify(app, canary,
      `UPDATE "RecordGrant" SET "anchorId"=$1 WHERE "userId"=$2`,
      [s.ungrantedOppId, s.canaryUserId],
      "a restricted member cannot edit a grant");
    await mustNotModify(app, canary,
      `DELETE FROM "RecordGrant" WHERE "userId"=$1`, [s.canaryUserId],
      "a restricted member cannot delete a grant");

    // Membership writes. These are enforced in the application — every path
    // runs through changeMemberRole, removeMember or setMemberScope, all of
    // which require members:manage and refuse a restricted actor — but
    // WorkspaceMember carries a restrictive policy for INSERT only, so at the
    // database layer they are governed by the permissive workspace rule alone.
    // Kept as real checks rather than notes: if the boundary is meant to be in
    // the database, this is where that would show.
    await mustNotModify(app, canary,
      `UPDATE "WorkspaceMember" SET "scopeMode"='workspace' WHERE id=$1`, [s.canaryMembershipId],
      "a restricted member cannot lift its own restriction in the database");
    await mustNotModify(app, canary,
      `UPDATE "WorkspaceMember" SET role='owner' WHERE id=$1`, [s.canaryMembershipId],
      "a restricted member cannot promote itself in the database");
    await mustNotModify(app, canary,
      `UPDATE "WorkspaceMember" SET "scopeMode"='restricted' WHERE id=$1`, [s.ownerMembershipId],
      "a restricted member cannot restrict the workspace owner in the database");
    await mustNotModify(app, canary,
      `DELETE FROM "WorkspaceMember" WHERE id=$1`, [s.otherMembershipId],
      "a restricted member cannot remove another member in the database");

    if (failures === 0 && s.phase === "accepted") {
      s.phase = "verified";
      saveState(s);
    }
  } finally {
    await app.end();
  }
}

// ---------------------------------------------------------------------------
// Phase: lifecycle
// ---------------------------------------------------------------------------

async function runLifecycle() {
  const s = loadState();
  if (!atLeast(s, "accepted")) halt("run the accept phase first");

  const app = await connect(APP_URL_DB);
  try {
    const owner = { workspaceId: s.workspaceId, userId: s.ownerUserId, restricted: false };
    const canary = { workspaceId: s.workspaceId, userId: s.canaryUserId, restricted: true };

    /** Grants are administered as the owner through the application role, which
     *  exercises 012's administrator arm rather than bypassing it. Committed,
     *  unlike the adversarial probes. */
    const administer = async (sql, params) => {
      await app.query("BEGIN");
      try {
        await app.query("SELECT set_config('app.workspace_ids', $1, true)", [owner.workspaceId]);
        await app.query("SELECT set_config('app.user_id', $1, true)", [owner.userId]);
        await app.query("SELECT set_config('app.restricted_workspace_ids', '', true)");
        await app.query(sql, params);
        await app.query("COMMIT");
      } catch (error) {
        await app.query("ROLLBACK");
        throw error;
      }
    };
    const grant = (anchorType, anchorId) =>
      administer(
        `INSERT INTO "RecordGrant"(id,"workspaceId","userId","membershipId","anchorType","anchorId","grantedById")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id("g"), s.workspaceId, s.canaryUserId, s.canaryMembershipId, anchorType, anchorId, s.ownerUserId],
      );
    const revoke = (anchorType, anchorId) =>
      administer(
        `DELETE FROM "RecordGrant" WHERE "workspaceId"=$1 AND "userId"=$2 AND "anchorType"=$3 AND "anchorId"=$4`,
        [s.workspaceId, s.canaryUserId, anchorType, anchorId],
      );
    const canSee = async (table, recordId) =>
      asPrincipal(app, canary, async () =>
        (await app.query(`SELECT id FROM "${table}" WHERE id=$1`, [recordId])).rows.length === 1);

    section("[lifecycle] the owner administers access; the canary's view follows");
    check("the owner may create a grant (012 administrator arm)", await grant("project", s.grantedProjectId)
      .then(() => true, (e) => { console.log(`        ${e.message.split("\n")[0]}`); return false; }));
    check("the newly granted project becomes visible", await canSee("Project", s.grantedProjectId));
    check("its milestone becomes visible", await canSee("Milestone", s.milestoneGrantedId));

    section("[lifecycle] the multi-anchor rule, in both directions");
    check("the dual-anchored task is still invisible", !(await canSee("Task", s.taskDualId)));
    await grant("project", s.ungrantedProjectId);
    check("granting the second anchor makes it visible", await canSee("Task", s.taskDualId));
    await revoke("project", s.ungrantedProjectId);
    check("revoking one anchor hides it again", !(await canSee("Task", s.taskDualId)));

    section("[lifecycle] revocation, and no fallback");
    await revoke("project", s.grantedProjectId);
    check("the project disappears immediately", !(await canSee("Project", s.grantedProjectId)));
    await revoke("opportunity", s.grantedOppId);
    await asPrincipal(app, canary, async () => {
      const count = async (t) => (await app.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
      check("with no grants, zero opportunities", (await count("Opportunity")) === 0);
      check("with no grants, zero projects", (await count("Project")) === 0);
      check("with no grants, zero contacts", (await count("Contact")) === 0);
      check("with no grants, zero companies", (await count("Company")) === 0);
      check("no fallback to workspace-wide access", (await count("Task")) === 0);
    });

    section("[lifecycle] restoring the intended grant set");
    await grant("opportunity", s.grantedOppId);
    check("the opportunity is reachable again", await canSee("Opportunity", s.grantedOppId));

    if (failures === 0 && ORDER.indexOf(s.phase) < ORDER.indexOf("exercised")) {
      s.phase = "exercised";
      saveState(s);
    }
  } finally {
    await app.end();
  }
}

// ---------------------------------------------------------------------------
// Phase: cleanup — reachable from every state after create
// ---------------------------------------------------------------------------

async function runCleanup() {
  const s = loadState();
  if (!s) {
    halt(
      `no state file at ${STATE_PATH}. Cleanup deletes by recorded id, never by guessing — ` +
        `if the state is lost, inspect the ${PREFIX}_* rows by hand.`,
    );
  }

  const admin = await connect(ADMIN_URL);
  try {
    section("[cleanup] in the order the dependencies require");

    // 1. Audit rows first, while the actor ids still exist. AuditLog.actorId is
    //    ON DELETE SET NULL and auth.signed_in rows carry no workspaceId, so
    //    they cascade with neither the workspace nor the user — and once the
    //    users are gone there is nothing left to identify them by.
    const actorIds = [s.ownerUserId, s.canaryUserId, s.otherUserId].filter(Boolean);
    const audit = await admin.query(
      `DELETE FROM "AuditLog" WHERE "workspaceId" IS NULL AND "actorId" = ANY($1::text[])`,
      [actorIds],
    );
    console.log(`  removed ${audit.rowCount} null-workspace audit row(s) attributable to the canary`);

    // 2. The workspace. Every one of its referencing foreign keys cascades,
    //    which removes memberships, grants, anchors, children, contacts,
    //    companies, deals, AI rows, invitations and workspace-scoped audit.
    const ws = s.workspaceId
      ? await admin.query(`DELETE FROM "Workspace" WHERE id = $1`, [s.workspaceId])
      : { rowCount: 0 };
    console.log(`  removed ${ws.rowCount} workspace (cascading its contents)`);

    // 3. The users. AiThread/AiMessage rows hang off the user rather than the
    //    workspace in some shapes, so this runs after the workspace and before
    //    the sweep that would catch anything either of them missed.
    const users = await admin.query(`DELETE FROM "User" WHERE id = ANY($1::text[])`, [actorIds]);
    console.log(`  removed ${users.rowCount} canary user(s)`);

    // 4. The sweep: nothing may be left anywhere.
    section("[cleanup] residual sweep");
    const residual = await residualCount(admin);
    check(`no ${PREFIX}_* rows remain`, residual.total === 0, residual.found.join(", "));

    const after = await captureBaseline(admin);
    check(`memberships back to ${EXPECT_MEMBERSHIPS}`, after.members.total === EXPECT_MEMBERSHIPS,
      String(after.members.total));
    check("0 restricted memberships", after.members.restricted === 0, String(after.members.restricted));
    check("RecordGrant empty", after.grants === 0, String(after.grants));
    check(`migrations still ${EXPECT_MIGRATIONS}`, after.migrations === EXPECT_MIGRATIONS,
      String(after.migrations));
    check("0 non-deferrable foreign keys", after.fks.nd === 0, `${after.fks.nd} of ${after.fks.total}`);
    check("/api/health 200", after.health.status === 200, String(after.health.status));
    check("/api/ready 200", after.ready === 200, String(after.ready));

    if (failures === 0) unlinkSync(STATE_PATH);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------

const PHASE_FN = {
  baseline: runBaseline, create: runCreate, accept: runAccept,
  verify: runVerify, lifecycle: runLifecycle, cleanup: runCleanup,
};

try {
  await PHASE_FN[phase]();
  console.log(
    `\n${failures === 0 ? `CANARY ${phase.toUpperCase()}: OK` : `CANARY ${phase.toUpperCase()}: ${failures} FAILURE(S)`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  if (error instanceof Halt) {
    console.error(`\nSTOPPED: ${error.message}\n`);
    process.exit(3);
  }
  console.error(`\nUNEXPECTED ERROR: ${error.message}\n`);
  process.exit(4);
}
