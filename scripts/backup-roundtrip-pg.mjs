#!/usr/bin/env node
/**
 * A real pg_dump → pg_restore round trip, asserting that the restored database
 * is still *secure* and not merely still *populated*.
 *
 * ## Why this exists alongside scripts/backup-test.mjs
 *
 * That script proves the data round-trips: row counts, a content fingerprint,
 * referential integrity. It does it with `COPY … TO STDOUT` because no `pg_dump`
 * is present on a developer machine, and it says so.
 *
 * Row counts are not the property that matters most here. Every tenant table is
 * `FORCE ROW LEVEL SECURITY`, and the audit log is append-only because the
 * application's database role is denied `UPDATE` and `DELETE` on it. Both of
 * those live in the catalogue, not in the rows — so a restore can return every
 * byte of customer data with tenant isolation missing and look perfect to a
 * count-based check. That is the failure this asserts against.
 *
 * It was written after an experiment corrected two beliefs:
 *
 *   1. A dump *does* carry policies, the RLS flags, functions, indexes and ACLs.
 *      The files in prisma/postgres/ are how the database got that way; they are
 *      not what is needed to put it back.
 *   2. A dump taken by a role that cannot bypass RLS **fails**, and leaves a
 *      partial file within a few percent of a good one's size. PostgreSQL's
 *      documented behaviour: pg_dump sets `row_security = off` "to ensure that
 *      all data is dumped from the table. If the user does not have sufficient
 *      privileges to bypass row security, then an error is thrown."
 *
 * ## It changes no roles
 *
 * Every check runs on one superuser connection and uses `SET ROLE tinycrm_app`
 * to borrow the application's identity. `SET ROLE` changes `current_user`, so RLS
 * binds and table privileges apply exactly as they would over a real connection —
 * verified, and it is why this needs no `ALTER ROLE`, no password and no login
 * attribute anywhere.
 *
 *   node scripts/backup-roundtrip-pg.mjs
 *
 * PostgreSQL only. Exits non-zero on any dump error, any restore error, any
 * posture difference, or any isolation failure.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const WORK = resolve(ROOT, ".backup-roundtrip");
const SRC = "tinycrm_rt_src";
const DST = "tinycrm_rt_dst";

const PORT = Number(process.env.PGPORT ?? 55432);
const HOST = process.env.PGHOST ?? "127.0.0.1";
const USER = process.env.PGUSER ?? "tinycrm";
const PASS = process.env.PGPASSWORD ?? "tinycrm";
const urlFor = (db) => `postgresql://${USER}:${PASS}@${HOST}:${PORT}/${db}`;

let failures = 0;
const step = (text) => console.log(`\n${text}`);
const ok = (text) => console.log(`   ok    ${text}`);
const fail = (text) => {
  console.error(`   FAIL  ${text}`);
  failures += 1;
};

async function connect(db) {
  const client = new Client({ connectionString: urlFor(db) });
  await client.connect();
  return client;
}

async function one(client, sql) {
  const result = await client.query(sql);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

/**
 * Runs `sql` as `tinycrm_app` and reports whether it was refused.
 *
 * Wrapped in a transaction that is always rolled back, so a statement that
 * *succeeds* when it should have been refused cannot leave a change behind.
 */
async function asAppRole(client, sql) {
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE tinycrm_app");
    const result = await client.query(sql);
    await client.query("ROLLBACK");
    // A multi-statement string ("SET LOCAL …; SELECT …") comes back as an array
    // of results rather than one, so `result.rows` is undefined for exactly the
    // cases that set a workspace context. Take the last statement's rows.
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    return { refused: false, rows: last?.rows ?? [] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { refused: true, message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Locating a usable pg_dump
// ---------------------------------------------------------------------------

/**
 * pg_dump refuses a server newer than itself, and the runner's preinstalled
 * client is routinely a major version behind the service container. So the
 * binary is chosen against the server's own version rather than assumed.
 */
function pgTool(name, serverMajor) {
  const candidates = [
    name,
    ...globSync(`/usr/lib/postgresql/*/bin/${name}`).sort().reverse(),
    `/opt/homebrew/opt/libpq/bin/${name}`,
    `/usr/local/opt/libpq/bin/${name}`,
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0 || !probe.stdout) continue;
    const major = Number(probe.stdout.match(/\s(\d+)[.\s]/)?.[1] ?? 0);
    if (major >= serverMajor) return { path: candidate, major };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Applies migrations and every file in prisma/postgres/, in filename order.
 *
 * Deliberately a glob rather than a hand-written list. There are already several
 * copies of that list in this repository and they have drifted from each other
 * before; a fifteenth would be a liability, and the numeric prefixes encode the
 * ordering that matters (002 defines the functions 004–014 call).
 */
function applySchema(db) {
  const env = { ...process.env, DATABASE_URL: urlFor(db) };
  const schemaPath = resolve(ROOT, "prisma/schema.prisma");
  const original = readFileSync(schemaPath, "utf8");

  try {
    execFileSync("node", ["scripts/use-provider.mjs", "postgresql"], { cwd: ROOT, stdio: "ignore" });
    execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "ignore", env });
    execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: ROOT, stdio: "ignore", env });

    const files = globSync("prisma/postgres/*.sql", { cwd: ROOT }).sort();
    if (files.length === 0) throw new Error("no SQL files found in prisma/postgres/");
    for (const file of files) {
      execFileSync("node", ["scripts/apply-sql.mjs", file], { cwd: ROOT, stdio: "ignore", env });
    }
    return files.length;
  } finally {
    // A local run must not leave the committed datasource provider rewritten —
    // and restoring the file is not enough on its own. `prisma generate` above
    // rewrote src/generated/prisma for PostgreSQL, and leaving it that way breaks
    // every SQLite test in the repository: the first run of this script took the
    // suite from 1184 passing to 52 failing. So the client is regenerated against
    // the restored schema, not just the schema put back.
    if (readFileSync(schemaPath, "utf8") !== original) {
      writeFileSync(schemaPath, original);
      execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "ignore" });
    }
  }
}

/** Two workspaces, so "isolation" has something to isolate. */
async function seed(client) {
  await client.query(`
    INSERT INTO "User" (id,email,name,"updatedAt") VALUES
      ('u_a','a@roundtrip.test','Owner A',now()),
      ('u_b','b@roundtrip.test','Owner B',now());
    INSERT INTO "Workspace" (id,name,slug,"ownerId","updatedAt") VALUES
      ('w_a','Alpha','alpha-rt','u_a',now()),
      ('w_b','Beta','beta-rt','u_b',now());
    INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role) VALUES
      ('m_a','w_a','u_a','owner'),
      ('m_b','w_b','u_b','owner');
    INSERT INTO "Contact" (id,"workspaceId","firstName","lastName","fullName","updatedAt") VALUES
      ('c_a1','w_a','Ann','Alpha','Ann Alpha',now()),
      ('c_a2','w_a','Abe','Alpha','Abe Alpha',now()),
      ('c_b1','w_b','Bob','Beta','Bob Beta',now());
    INSERT INTO "AuditLog" (id,action,summary) VALUES ('al_rt','test.event','a recorded event');
  `);
}

/**
 * The security posture, as numbers that must survive a round trip.
 *
 * `relacl` is read from the catalogue rather than from information_schema,
 * because information_schema.role_table_grants is filtered to roles the caller
 * is a member of and reports nothing for tinycrm_app even to a superuser.
 */
const POSTURE = `
  SELECT
    (SELECT count(*) FROM pg_policies WHERE schemaname='public')                      AS policies,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relrowsecurity)                                  AS rls_enabled,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relforcerowsecurity)                             AS rls_forced,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'app\\_%')                          AS app_functions,
    (SELECT count(*) FROM pg_indexes WHERE schemaname='public')                       AS indexes,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND array_to_string(c.relacl,',') LIKE '%tinycrm_app=%')                      AS tables_granting_app,
    (SELECT coalesce(array_to_string(relacl,','),'') FROM pg_class
      WHERE relname='AuditLog')                                                        AS auditlog_acl,
    (SELECT count(*) FROM "Contact")                                                  AS contacts
`;

async function posture(db) {
  const client = await connect(db);
  try {
    const { rows } = await client.query(POSTURE);
    return rows[0];
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const dumpFile = resolve(WORK, "source.dump");

  const admin = await connect("postgres");
  const serverNum = Number(await one(admin, "SHOW server_version_num"));
  const serverMajor = Math.floor(serverNum / 10000);

  const dump = pgTool("pg_dump", serverMajor);
  const restore = pgTool("pg_restore", serverMajor);
  if (!dump || !restore) {
    console.error(
      `\nNo pg_dump/pg_restore of major version >= ${serverMajor} was found.\n` +
        `This check needs real client binaries; install postgresql-client-${serverMajor}.\n`,
    );
    await admin.end();
    process.exit(1);
  }
  console.log(`server PostgreSQL ${serverMajor}, using ${dump.path} (${dump.major})`);

  step("[1] Build a source database with the full schema");
  for (const db of [SRC, DST]) {
    await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE "${SRC}"`);
  const applied = applySchema(SRC);
  ok(`migrations and ${applied} SQL files applied`);

  const src = await connect(SRC);
  await seed(src);
  ok("two-workspace fixture inserted");

  step("[2] Tripwire: FORCE RLS must actually be binding");
  // Without this the isolation assertions in step 6 could pass vacuously — on a
  // database where RLS was never enabled, every one of them would also hold.
  const bypass = await asAppRole(src, 'SET row_security=off; SELECT count(*) FROM "Contact"');
  if (bypass.refused && /row-level security/i.test(bypass.message ?? "")) {
    ok("a role without BYPASSRLS cannot read past the policies — this is what blocks pg_dump");
  } else {
    fail(
      "tinycrm_app was able to disable row security. FORCE RLS is not binding, so " +
        "nothing below proves anything.",
    );
  }

  const before = await posture(SRC);
  ok(
    `posture: ${before.policies} policies, ${before.rls_forced} forced, ` +
      `${before.app_functions} functions, ${before.indexes} indexes, ` +
      `${before.tables_granting_app} tables granting the app role`,
  );
  await src.end();

  step("[3] pg_dump — any error fails, and the artefact is discarded");
  const dumped = spawnSync(dump.path, ["-Fc", urlFor(SRC), "-f", dumpFile], { encoding: "utf8" });
  if (dumped.status !== 0) {
    // A failed pg_dump leaves a partial file behind, within a few percent of a
    // good one's size. Deleting it is the point: a size check cannot tell them
    // apart, so a truncated dump must never outlive the run that produced it.
    const partial = existsSync(dumpFile);
    rmSync(dumpFile, { force: true });
    fail(
      `pg_dump exited ${dumped.status}` +
        (partial ? " and left a partial file, which has been deleted" : "") +
        `\n         ${(dumped.stderr ?? "").split("\n")[0]}`,
    );
  } else if (!existsSync(dumpFile)) {
    fail("pg_dump reported success but wrote no file");
  } else {
    ok(`dump written, ${readFileSync(dumpFile).length} bytes`);
  }

  step("[4] pg_restore into an empty database — any error fails");
  if (failures === 0) {
    await admin.query(`CREATE DATABASE "${DST}"`);
    const restored = spawnSync(restore.path, ["-d", urlFor(DST), dumpFile], { encoding: "utf8" });
    const stderr = (restored.stderr ?? "").trim();
    // Both conditions, not either: pg_restore can exit 0 having skipped objects,
    // and it can exit 1 while having restored almost everything. The dangerous
    // case is the second — the role being absent produces exactly that, with
    // every privilege silently dropped.
    const errorLines = stderr.split("\n").filter((line) => /error/i.test(line));
    if (restored.status !== 0) {
      fail(`pg_restore exited ${restored.status}\n         ${errorLines[0] ?? stderr}`);
    } else if (errorLines.length > 0) {
      fail(`pg_restore exited 0 but reported ${errorLines.length} error(s)\n         ${errorLines[0]}`);
    } else {
      ok("restored with no errors on stderr");
    }
  }

  step("[5] The restored database must match the source, object for object");
  if (failures === 0) {
    const after = await posture(DST);
    for (const key of Object.keys(before)) {
      if (String(before[key]) === String(after[key])) {
        ok(`${key}: ${after[key]}`);
      } else {
        fail(`${key}: source ${before[key]} → restored ${after[key]}`);
      }
    }
  }

  step("[6] Tenant isolation and audit permissions, in the restored database");
  if (failures === 0) {
    const dst = await connect(DST);
    try {
      const visible = async (context) => {
        const sql = context
          ? `SET LOCAL app.workspace_ids='${context}'; SELECT id FROM "Contact" ORDER BY id`
          : `SELECT id FROM "Contact" ORDER BY id`;
        const result = await asAppRole(dst, sql);
        if (result.refused) return `refused: ${result.message}`;
        return result.rows.map((row) => row.id).join(",") || "none";
      };

      const cases = [
        [null, "none", "no workspace context sees nothing — deny by default survived"],
        ["w_a", "c_a1,c_a2", "scoped to w_a sees only w_a"],
        ["w_b", "c_b1", "scoped to w_b sees only w_b"],
        ["w_a,w_b", "c_a1,c_a2,c_b1", "scoped to both sees both"],
      ];
      for (const [context, expected, description] of cases) {
        const got = await visible(context);
        if (got === expected) ok(description);
        else fail(`${description} — expected "${expected}", got "${got}"`);
      }

      for (const [sql, label] of [
        [`UPDATE "AuditLog" SET summary='tampered'`, "UPDATE on AuditLog"],
        [`DELETE FROM "AuditLog"`, "DELETE on AuditLog"],
      ]) {
        const result = await asAppRole(dst, sql);
        if (result.refused && /permission denied/i.test(result.message ?? "")) {
          ok(`${label} is refused — the append-only revoke survived`);
        } else {
          fail(`${label} was permitted. The audit log is no longer append-only.`);
        }
      }

      const select = await asAppRole(dst, `SELECT count(*) FROM "AuditLog"`);
      if (!select.refused) ok("SELECT on AuditLog is still permitted");
      else fail(`SELECT on AuditLog was refused: ${select.message}`);

      const claim = await asAppRole(dst, `SELECT count(*) FROM app_claim_jobs('roundtrip',1,1)`);
      if (!claim.refused) ok("app_claim_jobs is still executable by the app role");
      else fail(`app_claim_jobs was refused: ${claim.message}`);
    } finally {
      await dst.end();
    }
  }

  step("[7] Clean up");
  for (const db of [SRC, DST]) {
    await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  }
  rmSync(WORK, { recursive: true, force: true });
  await admin.end();
  ok("scratch databases and dump removed");

  console.log(
    failures === 0
      ? "\nThe restored database is byte-for-byte as isolated as the source.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
