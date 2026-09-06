#!/usr/bin/env node
/**
 * Backup and restore, actually performed.
 *
 * The previous hardening report graded recoverability RED with the note that
 * "an untested backup is a hypothesis". This tests it: it builds a
 * representative database, backs it up, **destroys the original**, restores from
 * the backup alone, and then checks that what came back is what went in — row
 * counts, referential integrity, specific records, and the relationships between
 * them.
 *
 *   npm run test:backup
 *
 * ---------------------------------------------------------------------------
 * Why a logical dump written here rather than pg_dump
 * ---------------------------------------------------------------------------
 *
 * `pg_dump` is the right tool in production and is what docs/DEPLOYMENT-CHECKLIST
 * recommends. It is not present on this machine — the embedded PostgreSQL
 * package ships only `initdb`, `pg_ctl` and `postgres`. So the dump here uses
 * `COPY … TO STDOUT`, which is the same mechanism pg_dump uses for table data,
 * and restores the schema from the migration history rather than from the dump.
 *
 * That difference is worth stating plainly: this proves **the data round-trips
 * and the relationships survive**. It does not exercise pg_dump's own format,
 * nor a provider's point-in-time recovery. Those are verified against the real
 * provider, once, before launch — the checklist says so and this script does not
 * claim to replace it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const BACKUP_DIR = resolve(ROOT, ".backup-test");
const DATABASE = "tinycrm_backup";

const PORT = Number(process.env.PGPORT ?? 55432);
const ADMIN_URL = `postgresql://tinycrm:tinycrm@127.0.0.1:${PORT}/postgres`;
const TARGET_URL = `postgresql://tinycrm:tinycrm@127.0.0.1:${PORT}/${DATABASE}`;

/**
 * Tables in dependency order. A restore must insert parents before children, or
 * every foreign key fails — which is exactly the kind of thing that is only
 * discovered during an incident if nobody has tried it.
 */
const TABLE_ORDER = [
  "User", "Workspace", "WorkspaceMember", "UsageCounter",
  "Company", "Contact", "ProjectStatus", "Project", "Milestone",
  "Pipeline", "PipelineStage", "Deal", "Opportunity",
  "ProjectContact", "DealContact", "OpportunityContact",
  "Task", "Note", "Activity", "FileAsset",
  "Tag", "TagLink", "CustomFieldDef", "CustomFieldValue",
  "SavedView", "Automation", "AutomationRun",
  "AiInsight", "AiThread", "AiMessage",
  "Notification", "Integration", "EmailMessage", "CalendarEvent", "EventAttendee",
  "AuditLog", "AuthToken", "IdempotencyKey", "DomainEvent", "JobRun", "FeatureFlag",
  "UserSession", "MfaCredential", "MfaRecoveryCode", "SecurityAlert",
  "RateLimitCounter",
];

const step = (n, text) => console.log(`\n[${n}] ${text}`);
const ok = (text) => console.log(`   ok    ${text}`);
const fail = (text) => {
  console.error(`   FAIL  ${text}`);
  process.exitCode = 1;
};

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function recreateDatabase() {
  const admin = await connect(ADMIN_URL);
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}"`);
    await admin.query(`CREATE DATABASE "${DATABASE}"`);
  } finally {
    await admin.end();
  }
}

function applySchema() {
  const env = { ...process.env, DATABASE_URL: TARGET_URL };
  execFileSync("node", ["scripts/use-provider.mjs", "postgresql"], { cwd: ROOT, stdio: "ignore" });
  execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "ignore", env });
  execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: ROOT, stdio: "ignore", env });
  // Without this the restore in step 4 is impossible: Company and Contact
  // reference each other, so no table ordering satisfies both.
  execFileSync("node", ["scripts/apply-sql.mjs", "prisma/postgres/003_deferrable_constraints.sql"], {
    cwd: ROOT, stdio: "ignore", env,
  });
}

/** Streams one table out with COPY, the same path pg_dump uses for data. */
async function dumpTable(client, table) {
  const copyTo = require("pg-copy-streams").to;
  const stream = client.query(copyTo(`COPY "${table}" TO STDOUT WITH (FORMAT csv, HEADER true)`));

  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function restoreTable(client, table, data) {
  const copyFrom = require("pg-copy-streams").from;
  const stream = client.query(copyFrom(`COPY "${table}" FROM STDIN WITH (FORMAT csv, HEADER true)`));

  await new Promise((resolveDone, rejectDone) => {
    stream.on("finish", resolveDone);
    stream.on("error", rejectDone);
    stream.end(data);
  });
}

async function tableCounts(client) {
  const counts = {};
  for (const table of TABLE_ORDER) {
    const result = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
    counts[table] = result.rows[0].n;
  }
  return counts;
}

/** A fingerprint of the data, not just its size. */
async function fingerprint(client) {
  const [contacts, deals, activities, workspaces] = await Promise.all([
    client.query(`SELECT id, "fullName", email, "workspaceId", "companyId" FROM "Contact" ORDER BY id`),
    client.query(`SELECT id, name, "valueCents", "workspaceId", "stageId" FROM "Deal" ORDER BY id`),
    client.query(`SELECT count(*)::int AS n, sum(length(title))::int AS chars FROM "Activity"`),
    client.query(`SELECT id, name, slug FROM "Workspace" ORDER BY id`),
  ]);

  const { createHash } = require("node:crypto");
  const digest = createHash("sha256")
    .update(JSON.stringify(contacts.rows))
    .update(JSON.stringify(deals.rows))
    .update(JSON.stringify(activities.rows))
    .update(JSON.stringify(workspaces.rows))
    .digest("hex")
    .slice(0, 16);

  return {
    digest,
    contacts: contacts.rows.length,
    deals: deals.rows.length,
    workspaces: workspaces.rows.length,
    sampleContact: contacts.rows[0] ?? null,
    sampleDeal: deals.rows[0] ?? null,
  };
}

/** Confirms every foreign key still resolves. */
async function checkReferentialIntegrity(client) {
  const problems = [];

  const checks = [
    [`Contact -> Company`, `SELECT count(*)::int AS n FROM "Contact" c LEFT JOIN "Company" x ON c."companyId" = x.id WHERE c."companyId" IS NOT NULL AND x.id IS NULL`],
    [`Contact -> Workspace`, `SELECT count(*)::int AS n FROM "Contact" c LEFT JOIN "Workspace" w ON c."workspaceId" = w.id WHERE w.id IS NULL`],
    [`Deal -> Stage`, `SELECT count(*)::int AS n FROM "Deal" d LEFT JOIN "PipelineStage" s ON d."stageId" = s.id WHERE s.id IS NULL`],
    [`Deal -> Pipeline`, `SELECT count(*)::int AS n FROM "Deal" d LEFT JOIN "Pipeline" p ON d."pipelineId" = p.id WHERE p.id IS NULL`],
    [`Activity -> Workspace`, `SELECT count(*)::int AS n FROM "Activity" a LEFT JOIN "Workspace" w ON a."workspaceId" = w.id WHERE w.id IS NULL`],
    [`Task -> Workspace`, `SELECT count(*)::int AS n FROM "Task" t LEFT JOIN "Workspace" w ON t."workspaceId" = w.id WHERE w.id IS NULL`],
    [`Note -> Workspace`, `SELECT count(*)::int AS n FROM "Note" nt LEFT JOIN "Workspace" w ON nt."workspaceId" = w.id WHERE w.id IS NULL`],
    [`WorkspaceMember -> User`, `SELECT count(*)::int AS n FROM "WorkspaceMember" m LEFT JOIN "User" u ON m."userId" = u.id WHERE u.id IS NULL`],
    [`Milestone -> Project`, `SELECT count(*)::int AS n FROM "Milestone" ms LEFT JOIN "Project" p ON ms."projectId" = p.id WHERE p.id IS NULL`],
  ];

  for (const [label, sql] of checks) {
    const result = await client.query(sql);
    if (result.rows[0].n > 0) problems.push(`${label}: ${result.rows[0].n} dangling`);
  }

  // And ask PostgreSQL itself, which is the authority.
  const constraints = await client.query(`
    SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint WHERE contype = 'f' AND NOT convalidated
  `);
  for (const row of constraints.rows) {
    problems.push(`unvalidated constraint ${row.conname} on ${row.tbl}`);
  }

  return problems;
}

// ---------------------------------------------------------------------------

/**
 * Whether something is already accepting connections on the target port.
 *
 * Deliberately a real connection rather than a port probe: a port that is open
 * but not PostgreSQL, or one that rejects these credentials, must fall through
 * to starting the embedded cluster rather than failing later with a confusing
 * error halfway through the drill.
 */
async function serverIsReachable() {
  const client = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log("Backup and restore verification\n" + "=".repeat(60));

  // -------------------------------------------------------------------------
  step(1, "Build a representative database");

  // Only start the embedded cluster if no server is already listening. CI
  // supplies a real `postgres:17` service container, and this script used to
  // start the embedded cluster on top of it unconditionally — which fails on
  // the runner and is redundant when a server is already there. Reusing a
  // provided server is also what makes this runnable against any PostgreSQL,
  // which is what docs/POSTGRES-VERIFICATION.md tells the reader to do.
  if (await serverIsReachable()) {
    ok(`using the PostgreSQL already listening on port ${PORT}`);
  } else {
    execFileSync("node", ["scripts/pg.mjs", "start"], { cwd: ROOT, stdio: "ignore" });
  }
  await recreateDatabase();
  applySchema();

  execFileSync("npx", ["tsx", "prisma/seed/test-seed.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      DATABASE_URL: TARGET_URL,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
    },
  });

  let client = await connect(TARGET_URL);
  const before = await tableCounts(client);
  const beforePrint = await fingerprint(client);
  const totalRows = Object.values(before).reduce((a, b) => a + b, 0);
  await client.end();

  ok(`${totalRows} rows across ${Object.keys(before).length} tables`);
  ok(`fingerprint ${beforePrint.digest}`);

  // -------------------------------------------------------------------------
  step(2, "Take a backup");
  const backupStart = performance.now();
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  mkdirSync(BACKUP_DIR, { recursive: true });

  client = await connect(TARGET_URL);
  let bytes = 0;
  for (const table of TABLE_ORDER) {
    const data = await dumpTable(client, table);
    writeFileSync(resolve(BACKUP_DIR, `${table}.csv`), data);
    bytes += data.length;
  }
  writeFileSync(
    resolve(BACKUP_DIR, "manifest.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), counts: before, tables: TABLE_ORDER }, null, 2),
  );
  await client.end();

  const backupSeconds = (performance.now() - backupStart) / 1000;
  ok(`${(bytes / 1024).toFixed(0)} KB written in ${backupSeconds.toFixed(1)}s`);

  // -------------------------------------------------------------------------
  step(3, "Destroy the original");
  await recreateDatabase();
  applySchema();

  client = await connect(TARGET_URL);
  const afterDestruction = await tableCounts(client);
  await client.end();

  const survivors = Object.entries(afterDestruction).filter(([, n]) => n > 0);
  if (survivors.length > 0) {
    fail(`the database was not actually empty: ${survivors.map(([t, n]) => `${t}=${n}`).join(", ")}`);
    return;
  }
  ok("every table is empty — the restore has nothing to fall back on");

  // -------------------------------------------------------------------------
  step(4, "Restore from the backup alone");
  const restoreStart = performance.now();
  client = await connect(TARGET_URL);

  const manifest = JSON.parse(readFileSync(resolve(BACKUP_DIR, "manifest.json"), "utf8"));
  await client.query("BEGIN");
  // Constraints are deferred to COMMIT, not disabled. The whole graph is still
  // verified — once, at the end — which is the only way to load a schema whose
  // foreign keys contain a cycle. See prisma/postgres/003_deferrable_constraints.sql.
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  for (const table of manifest.tables) {
    const path = resolve(BACKUP_DIR, `${table}.csv`);
    if (!existsSync(path)) continue;
    const data = readFileSync(path);
    // Header-only means an empty table; COPY handles it, but skip the round trip.
    if (data.toString("utf8").trim().split("\n").length <= 1) continue;
    await restoreTable(client, table, data);
  }
  // If anything in the graph is dangling, this is where it fails — all or
  // nothing, rather than a half-restored database that looks fine.
  await client.query("COMMIT");

  const restoreSeconds = (performance.now() - restoreStart) / 1000;
  ok(`restored in ${restoreSeconds.toFixed(1)}s`);

  // -------------------------------------------------------------------------
  step(5, "Check what came back");

  const after = await tableCounts(client);
  let countsMatch = true;
  for (const table of TABLE_ORDER) {
    if (before[table] !== after[table]) {
      fail(`${table}: ${before[table]} rows before, ${after[table]} after`);
      countsMatch = false;
    }
  }
  if (countsMatch) ok(`all ${totalRows} rows restored, table by table`);

  const afterPrint = await fingerprint(client);
  if (afterPrint.digest === beforePrint.digest) {
    ok(`fingerprint matches (${afterPrint.digest}) — values and relationships identical`);
  } else {
    fail(`fingerprint changed: ${beforePrint.digest} -> ${afterPrint.digest}`);
  }

  const problems = await checkReferentialIntegrity(client);
  if (problems.length === 0) ok("every foreign key resolves");
  else problems.forEach(fail);

  // A specific record, followed through its relationships, because aggregate
  // counts can match while the graph is wrong.
  const walk = await client.query(`
    SELECT c."fullName" AS contact, co.name AS company, d.name AS deal,
           d."valueCents", s.name AS stage, w.name AS workspace
    FROM "Contact" c
    JOIN "Company" co ON c."companyId" = co.id
    JOIN "Deal" d ON d."primaryContactId" = c.id
    JOIN "PipelineStage" s ON d."stageId" = s.id
    JOIN "Workspace" w ON d."workspaceId" = w.id
    ORDER BY c."fullName"
    LIMIT 1
  `);
  if (walk.rows.length === 1) {
    const row = walk.rows[0];
    ok(`relationship walk: ${row.contact} → ${row.company} → "${row.deal}" (${row.stage}) in ${row.workspace}`);
  } else {
    fail("a contact → company → deal → stage → workspace walk found nothing");
  }

  // Tenant separation must survive a restore: if the two seeded tenants ended up
  // sharing rows, the restore silently merged customers.
  const bleed = await client.query(`
    SELECT count(*)::int AS n
    FROM "Contact" c JOIN "Company" co ON c."companyId" = co.id
    WHERE c."workspaceId" <> co."workspaceId"
  `);
  if (bleed.rows[0].n === 0) ok("no cross-tenant references were introduced");
  else fail(`${bleed.rows[0].n} contacts now reference another tenant's company`);

  await client.end();

  // -------------------------------------------------------------------------
  step(6, "Run the isolation suite against the restored database");
  try {
    execFileSync(
      "npx",
      ["tsx", "--test", "--test-concurrency=1", "tests/security/tenant-isolation.test.ts"],
      {
        cwd: ROOT,
        stdio: "ignore",
        env: {
          ...process.env,
          DATABASE_URL: TARGET_URL,
          NODE_ENV: "test",
          AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
        },
      },
    );
    ok("tenant isolation holds on the restored database");
  } catch {
    fail("the isolation suite failed against the restored database");
  }

  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  if (process.exitCode) {
    console.log("RESTORE VERIFICATION: FAILED");
  } else {
    console.log("RESTORE VERIFICATION: PASSED");
    console.log(
      `\n  Backed up ${totalRows} rows in ${backupSeconds.toFixed(1)}s\n` +
        `  Restored  ${totalRows} rows in ${restoreSeconds.toFixed(1)}s\n` +
        `  Fingerprint identical, referential integrity intact, isolation intact.\n`,
    );
  }

  // Leave the SQLite datasource as we found it.
  execFileSync("node", ["scripts/use-provider.mjs", "sqlite"], { cwd: ROOT, stdio: "ignore" });
  execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "ignore" });
  rmSync(BACKUP_DIR, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  execFileSync("node", ["scripts/use-provider.mjs", "sqlite"], { cwd: ROOT, stdio: "ignore" });
  process.exit(1);
});
