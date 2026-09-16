#!/usr/bin/env node
/**
 * Proves the deployment gate against real PostgreSQL, in both directions.
 *
 * tests/unit/deploy-gate.test.ts pins the verdict logic with no database. This
 * runs the actual script, as the actual restricted role, against databases that
 * are actually in each state — because the gate's value is entirely in what it
 * does against a real server, and a gate that only passes its unit tests is a
 * gate nobody has watched block anything.
 *
 * One database is migrated and given the policy files exactly as production is.
 * Each failure is then a clone of it with a single cause introduced, so a block
 * can only be attributed to that cause:
 *
 *   current   nothing wrong                              → must PASS
 *   behind    the newest migration's ledger row removed  → must BLOCK, naming it
 *   fk        one foreign key made NOT DEFERRABLE         → must BLOCK, naming it
 *   force     one table's FORCE ROW LEVEL SECURITY off   → must BLOCK, naming it
 *   norls     one workspace table's RLS disabled          → must BLOCK, naming it,
 *             and not the documented exception
 *
 * "behind" removes a ledger row from its own throwaway clone rather than
 * withholding a migration, deliberately: the catalogs stay intact, so the
 * migration check is the only thing that can fire, and it works unchanged for
 * whatever the newest migration happens to be.
 *
 * The norls case runs twice — as tinycrm_app, and as a role that can read
 * nothing but the migration ledger — and demonstrates that information_schema
 * would have hidden the unprotected table from the second.
 *
 * Every database and role this creates is dropped at the end, pass or fail. No
 * production credential is involved.
 *
 *   ADMIN_DATABASE_URL   a role that can CREATE DATABASE and own migrations
 *   APP_ROLE_PASSWORD    tinycrm_app's password on this server (default tinycrm_app)
 *
 * Requires the Prisma datasource provider to be postgresql (the PostgreSQL CI
 * job switches it; locally, run scripts/use-provider.mjs postgresql first).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = process.env.ADMIN_DATABASE_URL;
const APP_PASSWORD = process.env.APP_ROLE_PASSWORD ?? "tinycrm_app";

if (!ADMIN) {
  console.error("ADMIN_DATABASE_URL is required.");
  process.exit(2);
}
if (!/provider\s*=\s*"postgresql"/.test(readFileSync(resolve(ROOT, "prisma/schema.prisma"), "utf8"))) {
  console.error('The Prisma datasource provider is not "postgresql". Run: node scripts/use-provider.mjs postgresql');
  process.exit(2);
}

const redact = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");

const suffix = `gp${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const DB = {
  current: `${suffix}_current`,
  behind: `${suffix}_behind`,
  fk: `${suffix}_fk`,
  force: `${suffix}_force`,
  norls: `${suffix}_norls`,
};
const PROBE_ROLE = `gate_probe_${suffix}`;
const PROBE_PASSWORD = randomBytes(18).toString("hex");

function urlFor(database, user, password) {
  const url = new URL(ADMIN);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = password;
  }
  return url.toString();
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The gate, with nothing inherited but PATH — so no stray variable could influence it. */
function gate(databaseUrl) {
  const env = { PATH: process.env.PATH, VERCEL: "1", VERCEL_ENV: "production" };
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  return run("node", ["scripts/deploy-gate.mjs"], env);
}

/** The indented item lines under each ✕ problem heading. */
function reportedItems(output) {
  return [...output.matchAll(/^ {6}(\S+)\s*$/gm)].map((m) => m[1]);
}

const results = [];
function expect(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const created = [];

try {
  const shipped = JSON.parse(
    run("node", ["-e", `import("./scripts/deploy-gate.mjs").then(m => console.log(JSON.stringify(m.shippedMigrations())))`], {
      PATH: process.env.PATH,
    }).output.trim().split("\n").pop(),
  );
  const newest = shipped.at(-1);
  console.log(`\nDeployment gate proof — ${shipped.length} migrations shipped, newest ${newest}\n`);

  // --- The fully migrated database, built the way production is -------------
  console.log("[setup] building the current database");
  await withClient(ADMIN, (c) => c.query(`CREATE DATABASE "${DB.current}"`));
  created.push(DB.current);
  const ownerCurrent = urlFor(DB.current);

  const migrate = run("npx", ["prisma", "migrate", "deploy", "--config", "prisma7.config.ts"], {
    ...process.env, DATABASE_URL: ownerCurrent, DIRECT_URL: ownerCurrent,
  });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed:\n${redact(migrate.output)}`);
  for (const file of ["001_search_indexes", "002_row_level_security", "003_deferrable_constraints",
    "004_workspace_bootstrap", "005_identity_policies", "006_job_claim", "007_account_scoped_ai_threads"]) {
    const applied = run("node", ["scripts/apply-sql.mjs", `prisma/postgres/${file}.sql`], {
      ...process.env, DATABASE_URL: ownerCurrent,
    });
    if (applied.status !== 0) throw new Error(`${file}.sql failed:\n${redact(applied.output)}`);
  }

  const appLogin = await withClient(ADMIN, async (c) =>
    (await c.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'tinycrm_app'`)).rows[0]?.rolcanlogin);
  if (!appLogin) throw new Error("tinycrm_app cannot log in on this server; give it a login first (see the CI job).");

  // --- Single-cause clones -----------------------------------------------------
  console.log("[setup] cloning one database per failure");
  for (const key of ["behind", "fk", "force", "norls"]) {
    await withClient(ADMIN, (c) => c.query(`CREATE DATABASE "${DB[key]}" TEMPLATE "${DB.current}"`));
    created.push(DB[key]);
  }
  await withClient(ADMIN, async (c) => {
    for (const name of Object.values(DB)) await c.query(`GRANT CONNECT ON DATABASE "${name}" TO tinycrm_app`);
  });

  const removedMigration = await withClient(urlFor(DB.behind), async (c) =>
    (await c.query(`DELETE FROM "_prisma_migrations"
      WHERE migration_name = (SELECT migration_name FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 1)
      RETURNING migration_name`)).rows[0]?.migration_name);

  const brokenForeignKey = await withClient(urlFor(DB.fk), async (c) => {
    const fk = (await c.query(`SELECT rel.relname AS tbl, con.conname AS name FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.contype = 'f' AND rel.relnamespace = 'public'::regnamespace ORDER BY con.conname LIMIT 1`)).rows[0];
    await c.query(`ALTER TABLE "${fk.tbl}" ALTER CONSTRAINT "${fk.name}" NOT DEFERRABLE`);
    return `${fk.tbl}.${fk.name}`;
  });

  await withClient(urlFor(DB.force), (c) => c.query(`ALTER TABLE "Company" NO FORCE ROW LEVEL SECURITY`));
  await withClient(urlFor(DB.norls), (c) => c.query(`ALTER TABLE "Company" DISABLE ROW LEVEL SECURITY`));

  // A role that can read nothing but the ledger.
  await withClient(ADMIN, async (c) => {
    await c.query(`CREATE ROLE "${PROBE_ROLE}" LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await c.query(`GRANT CONNECT ON DATABASE "${DB.norls}" TO "${PROBE_ROLE}"`);
  });
  await withClient(urlFor(DB.norls), async (c) => {
    await c.query(`GRANT USAGE ON SCHEMA public TO "${PROBE_ROLE}"`);
    await c.query(`GRANT SELECT ON "_prisma_migrations" TO "${PROBE_ROLE}"`);
  });

  const app = (database) => urlFor(database, "tinycrm_app", APP_PASSWORD);
  const ledger = async (database) => withClient(urlFor(database), async (c) =>
    (await c.query(`SELECT count(*)::int AS n FROM "_prisma_migrations"`)).rows[0].n);
  const ledgerBefore = { current: await ledger(DB.current), behind: await ledger(DB.behind) };

  // --- The gate, against each ------------------------------------------------
  console.log("\n[1] a fully migrated database passes");
  const current = gate(app(DB.current));
  expect("exit 0", current.status === 0, `exit ${current.status}`);
  expect("reports PASSED", /DEPLOYMENT GATE: PASSED/.test(current.output));
  expect("counts every shipped migration as applied",
    current.output.includes(`${shipped.length} shipped by this commit, ${shipped.length} applied`));

  console.log("\n[2] a database one migration behind is blocked, and the migration is named");
  expect("precondition: the clone really lost the newest migration", removedMigration === newest,
    `removed ${removedMigration}`);
  const behind = gate(app(DB.behind));
  expect("exit 1", behind.status === 1, `exit ${behind.status}`);
  expect("reports BLOCKED", /DEPLOYMENT GATE: BLOCKED/.test(behind.output));
  expect("names exactly the missing migration", JSON.stringify(reportedItems(behind.output)) === JSON.stringify([newest]),
    `items: ${reportedItems(behind.output).join(", ")}`);
  expect("says a migration is not applied", /1 migration shipped by this commit is not applied/.test(behind.output));

  console.log("\n[3] a non-deferrable foreign key is blocked, and named");
  const fk = gate(app(DB.fk));
  expect("exit 1", fk.status === 1, `exit ${fk.status}`);
  expect("names exactly that foreign key", JSON.stringify(reportedItems(fk.output)) === JSON.stringify([brokenForeignKey]),
    `items: ${reportedItems(fk.output).join(", ")}`);

  console.log("\n[4] row-level security without FORCE is blocked, and named");
  const force = gate(app(DB.force));
  expect("exit 1", force.status === 1, `exit ${force.status}`);
  expect("names exactly Company", JSON.stringify(reportedItems(force.output)) === JSON.stringify(["Company"]),
    `items: ${reportedItems(force.output).join(", ")}`);

  console.log("\n[5] a workspace table without row-level security is blocked, and the documented exception is not");
  const norls = gate(app(DB.norls));
  expect("exit 1", norls.status === 1, `exit ${norls.status}`);
  expect("names exactly Company, not IdempotencyKey",
    JSON.stringify(reportedItems(norls.output)) === JSON.stringify(["Company"]),
    `items: ${reportedItems(norls.output).join(", ")}`);

  console.log("\n[6] the same, as a role that can read nothing but the ledger");
  const hiddenByInformationSchema = await withClient(urlFor(DB.norls, PROBE_ROLE, PROBE_PASSWORD), async (c) =>
    (await c.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'workspaceId'`)).rows[0].n);
  expect("precondition: information_schema hides every workspaceId column from this role",
    hiddenByInformationSchema === 0, `${hiddenByInformationSchema} visible`);
  const leastPrivilege = gate(urlFor(DB.norls, PROBE_ROLE, PROBE_PASSWORD));
  expect("exit 1 — the gate still sees the unprotected table", leastPrivilege.status === 1, `exit ${leastPrivilege.status}`);
  expect("names exactly Company", JSON.stringify(reportedItems(leastPrivilege.output)) === JSON.stringify(["Company"]),
    `items: ${reportedItems(leastPrivilege.output).join(", ")}`);

  console.log("\n[7] it fails closed when it cannot prove anything");
  const noUrl = gate(undefined);
  expect("no DATABASE_URL → exit 1", noUrl.status === 1 && /no PostgreSQL DATABASE_URL/.test(noUrl.output), `exit ${noUrl.status}`);
  const sqlite = gate("file:./dev.db");
  expect("a SQLite DATABASE_URL → exit 1", sqlite.status === 1 && /no PostgreSQL DATABASE_URL/.test(sqlite.output), `exit ${sqlite.status}`);
  const unreachable = gate("postgresql://nobody:nothing@127.0.0.1:1/none");
  expect("an unreachable database → exit 1", unreachable.status === 1 && /could not read the database/.test(unreachable.output),
    `exit ${unreachable.status}`);
  expect("no connection string appears in any output",
    ![current, behind, fk, force, norls, leastPrivilege, unreachable].some((r) => /postgres(ql)?:\/\/[^\s[]/.test(r.output)));

  console.log("\n[8] a preview with no DATABASE_URL is skipped, and never uses real credentials planted elsewhere");
  // The current database's own working credentials, in every place a careless
  // fallback might look — including the PG* variables node-postgres defaults to.
  const realUrl = app(DB.current);
  const real = new URL(realUrl);
  const planted = {
    DIRECT_URL: realUrl, POSTGRES_URL: realUrl, POSTGRES_PRISMA_URL: realUrl, DATABASE_URL_UNPOOLED: realUrl,
    PGHOST: real.hostname, PGPORT: real.port || "5432", PGUSER: decodeURIComponent(real.username),
    PGPASSWORD: decodeURIComponent(real.password), PGDATABASE: real.pathname.slice(1),
  };
  const preview = run("node", ["scripts/deploy-gate.mjs"], { PATH: process.env.PATH, VERCEL: "1", VERCEL_ENV: "preview", ...planted });
  expect("preview, no DATABASE_URL → exit 0", preview.status === 0, `exit ${preview.status}`);
  expect("reports SKIPPED, and why",
    /DEPLOYMENT GATE: SKIPPED — preview build has no isolated Preview database/.test(preview.output));
  expect("identifies no database — the planted credentials were not used", !/database fingerprint/.test(preview.output));
  const productionPlanted = run("node", ["scripts/deploy-gate.mjs"], { PATH: process.env.PATH, VERCEL: "1", VERCEL_ENV: "production", ...planted });
  expect("production, no DATABASE_URL, same credentials planted → exit 1, never skipped",
    productionPlanted.status === 1 && /no PostgreSQL DATABASE_URL/.test(productionPlanted.output) && !/SKIPPED/.test(productionPlanted.output),
    `exit ${productionPlanted.status}`);
  expect("… and identifies no database either", !/database fingerprint/.test(productionPlanted.output));
  expect("no credential appears in either output",
    ![preview, productionPlanted].some((r) => r.output.includes(planted.PGPASSWORD) || /postgres(ql)?:\/\/[^\s[]/.test(r.output)));

  console.log("\n[9] it wrote nothing");
  expect("the current database's ledger is unchanged", (await ledger(DB.current)) === ledgerBefore.current);
  expect("the behind database's ledger is unchanged", (await ledger(DB.behind)) === ledgerBefore.behind);
} catch (error) {
  expect("proof setup completed", false, redact(error instanceof Error ? error.message : error));
} finally {
  await withClient(ADMIN, async (c) => {
    if (created.length > 0) {
      await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()`, [created]);
    }
    for (const name of created) await c.query(`DROP DATABASE IF EXISTS "${name}"`);
    await c.query(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`);
  }).catch((error) => console.log(`  (cleanup warning: ${redact(error.message)})`));
  console.log(`  cleaned up ${created.length} database(s) and the probe role`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n================================================================\n  passed ${results.length - failed}   failed ${failed}\n================================================================\n`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
