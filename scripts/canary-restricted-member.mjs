#!/usr/bin/env node
/**
 * The first restricted member, in production, under controlled conditions.
 *
 * NOTE ON COMPLETENESS: the `create` phase is deliberately a stub. It runs the
 * baseline gate and then stops, because writing fixtures to production is the
 * subject of a separate go/no-go. The helpers that phase will need — password
 * hashing, invitation-token hashing, state persistence — arrive with it rather
 * than sitting here unused.
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
 *   node scripts/canary-restricted-member.mjs baseline  --production-canary-confirmed \
 *     --expect-memberships=18 --expect-migrations=7
 *   node scripts/canary-restricted-member.mjs create    --production-canary-confirmed ...
 *   node scripts/canary-restricted-member.mjs verify    --production-canary-confirmed ...
 *   node scripts/canary-restricted-member.mjs cleanup   --production-canary-confirmed ...
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
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const PREFIX = "TEAM2_CANARY";
const EMAIL_PREFIX = "team2-canary";
const CONFIRM_FLAG = "--production-canary-confirmed";
const PHASES = ["baseline", "create", "verify", "cleanup"];

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
      `           --expect-memberships=<n> --expect-migrations=<n> [--expect-release=<sha>] [--state=<path>]\n\n` +
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

/** An attempted write that must be refused. Rolls back whatever happens. */
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

// ---------------------------------------------------------------------------
// State, carried between phases
// ---------------------------------------------------------------------------

const loadState = () => {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
};

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

async function runBaseline() {
  const admin = await connect(ADMIN_URL);
  try {
    reportBaseline(await captureBaseline(admin));
  } finally {
    await admin.end();
  }
}

async function runCreate() {
  const admin = await connect(ADMIN_URL);
  try {
    const baseline = await captureBaseline(admin);
    reportBaseline(baseline);
    if (failures > 0) {
      halt("baseline did not match the approved expectations — nothing was created");
    }
    if (baseline.residual.total > 0) {
      halt(
        `${PREFIX}_* artifacts already exist (${baseline.residual.found.join(", ")}). ` +
          `A previous run did not finish. Inspect them; this script will not remove what it did not create.`,
      );
    }
    if (existsSync(STATE_PATH)) {
      halt(`a state file already exists at ${STATE_PATH} — resolve the previous run before starting another`);
    }

    console.log("\n[create] fixtures would be created here.");
    console.log("         Deliberately not implemented until the execution approval:");
    console.log("         this phase writes to production and is the subject of the final go/no-go.");
    halt("create is gated on the separate execution approval");
  } finally {
    await admin.end();
  }
}

async function runVerify() {
  const state = loadState();
  if (!state) halt(`no state file at ${STATE_PATH} — run the create phase first`);

  const app = await connect(APP_URL_DB);
  try {
    const canary = { workspaceId: state.workspaceId, userId: state.canaryUserId, restricted: true };

    section("[verify] the grant table defends itself (012, behaviourally, in production)");
    await mustRefuse(
      app, canary,
      `INSERT INTO "RecordGrant"(id,"workspaceId","userId","membershipId","anchorType","anchorId")
       VALUES ($1,$2,$3,$4,'opportunity',$5)`,
      [`g${randomBytes(12).toString("hex")}`, state.workspaceId, state.canaryUserId,
       state.canaryMembershipId, state.ungrantedOpportunityId],
      "a restricted member cannot grant themselves an unseen opportunity",
    );
    await mustRefuse(
      app, canary,
      `UPDATE "RecordGrant" SET "anchorId" = $1 WHERE "userId" = $2`,
      [state.ungrantedOpportunityId, state.canaryUserId],
      "a restricted member cannot edit a grant",
    );
    await mustRefuse(
      app, canary,
      `DELETE FROM "RecordGrant" WHERE "userId" = $1`,
      [state.canaryUserId],
      "a restricted member cannot delete a grant",
    );

    await asPrincipal(app, canary, async () => {
      const { rows } = await app.query(`SELECT "userId" FROM "RecordGrant"`);
      const foreign = rows.filter((r) => r.userId !== state.canaryUserId);
      check("a restricted member sees only their own grants", foreign.length === 0,
        `${rows.length} visible, ${foreign.length} belonging to someone else`);
      check("a restricted member sees their own grants at all", rows.length > 0, `${rows.length}`);
    });

    console.log("\n[verify] the remaining proofs run against fixtures created by the create phase,");
    console.log("         which is gated on the execution approval.");
  } finally {
    await app.end();
  }
}

async function runCleanup() {
  const state = loadState();
  if (!state) {
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
    const actorIds = [state.ownerUserId, state.canaryUserId, state.otherUserId].filter(Boolean);
    const audit = await admin.query(
      `DELETE FROM "AuditLog" WHERE "workspaceId" IS NULL AND "actorId" = ANY($1::text[])`,
      [actorIds],
    );
    console.log(`  removed ${audit.rowCount} null-workspace audit row(s) attributable to the canary`);

    // 2. The workspace. Every one of its 31 referencing foreign keys cascades,
    //    which removes memberships, grants, anchors, children, contacts,
    //    companies, deals, AI rows, invitations and workspace-scoped audit.
    const ws = await admin.query(`DELETE FROM "Workspace" WHERE id = $1`, [state.workspaceId]);
    console.log(`  removed ${ws.rowCount} workspace (cascading its contents)`);

    // 3. The users.
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
  baseline: runBaseline, create: runCreate, verify: runVerify, cleanup: runCleanup,
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
