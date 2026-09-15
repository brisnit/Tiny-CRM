#!/usr/bin/env node
/**
 * The deployment gate: a build does not proceed unless the database it will run
 * against can actually run it.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Two production defects, both invisible to every check we had:
 *
 *  - On 2026-09-11, commit f63c555 shipped a migration and Vercel deployed it on
 *    push. The migration was not applied for four days. Readiness reported
 *    `schema_behind` the whole time, but nothing stops a deploy because
 *    readiness said so, and "apply the migration before pushing" lived only in
 *    somebody's memory.
 *  - On 2026-09-10, the import-batch migration was applied without re-running
 *    the policy files, leaving three foreign keys non-deferrable. A logical
 *    restore would have failed for five days, while hosted verification
 *    reported "108 deferrable foreign keys" as a pass.
 *
 * So this runs as the first step of every Vercel build (`buildCommand` in
 * vercel.json), before the application is built at all. `vercel build` runs
 * that same command, which is what gates an output built locally for
 * `vercel deploy --prebuilt`: see docs/VERCEL-DEPLOYMENT.md.
 *
 * ---------------------------------------------------------------------------
 * What it checks — all read-only, as whatever role DATABASE_URL names
 * ---------------------------------------------------------------------------
 *
 *   1. every migration this commit ships in prisma/migrations-postgres is
 *      applied (finished, not rolled back). A database *ahead* of the commit
 *      passes — the same rule as /api/ready, so a rollback is never blocked.
 *   2. no foreign key in the public schema is non-deferrable.
 *   3. no table has row-level security enabled without FORCE.
 *   4. every table with a `workspaceId` column has row-level security, except
 *      the exceptions documented in docs/RLS.md.
 *
 * ---------------------------------------------------------------------------
 * How it fails
 * ---------------------------------------------------------------------------
 *
 * Closed, in every case it cannot prove the database compatible: no PostgreSQL
 * DATABASE_URL, an unreachable database, an unreadable ledger, a query error.
 * It never runs a migration and never writes; its reads run in a READ ONLY
 * transaction. There is no override — no environment variable, no flag. The
 * only ways past a block are to fix the database, or to change this file in
 * source control, where the change is reviewed and CI runs.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tables that carry a `workspaceId` column but intentionally have no RLS.
 *
 * This must equal the tables listed under "Which tables intentionally do not"
 * in docs/RLS.md that have a `workspaceId` column. tests/unit/deploy-gate.test.ts
 * fails if the two ever disagree, so an exception cannot be added here quietly.
 */
export const RLS_EXCEPTIONS = Object.freeze(["IdempotencyKey"]);

/**
 * The read-only queries, exported so tests can prove what they are.
 *
 * `workspaceId` is found through `pg_attribute`, deliberately not
 * `information_schema.columns`: that view only lists columns the connected role
 * has a privilege on, so a low-privilege role would see no `workspaceId`
 * columns at all and the check would pass on a database with none of its RLS.
 */
export const QUERIES = Object.freeze({
  applied: `SELECT migration_name AS name FROM public."_prisma_migrations"
            WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1`,
  nonDeferrableForeignKeys: `SELECT rel.relname || '.' || con.conname AS name
            FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
            WHERE con.contype = 'f' AND rel.relnamespace = 'public'::regnamespace
              AND NOT con.condeferrable ORDER BY 1`,
  rlsNotForced: `SELECT relname AS name FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
              AND relrowsecurity AND NOT relforcerowsecurity ORDER BY 1`,
  workspaceTablesWithoutRls: `SELECT c.relname AS name FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
              AND NOT c.relrowsecurity
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                          AND a.attname = 'workspaceId' AND a.attnum > 0 AND NOT a.attisdropped)
            ORDER BY 1`,
});

/** The migrations this commit ships, named and ordered exactly as the readiness manifest names them. */
export function shippedMigrations(root = ROOT) {
  try {
    return readdirSync(resolve(root, "prisma/migrations-postgres"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The verdict, as a pure function of what was read.
 *
 * Every problem is reported, not only the first: a database that is both behind
 * and missing a policy should say both, so one redeploy fixes both.
 *
 * @param {{
 *   shipped: readonly string[], applied: readonly string[],
 *   nonDeferrableForeignKeys: readonly string[], rlsNotForced: readonly string[],
 *   workspaceTablesWithoutRls: readonly string[], exceptions?: readonly string[],
 * }} input
 * @returns {{ ok: boolean, problems: { kind: string, items: string[] }[] }}
 */
export function evaluate(input) {
  const exceptions = input.exceptions ?? RLS_EXCEPTIONS;
  const problems = [];

  // A commit that ships no migrations cannot be proven compatible with
  // anything. It means the directory is missing from the build, not that there
  // is nothing to check.
  if (input.shipped.length === 0) problems.push({ kind: "no_shipped_migrations", items: [] });

  const applied = new Set(input.applied);
  const missing = input.shipped.filter((name) => !applied.has(name));
  if (missing.length > 0) problems.push({ kind: "missing_migrations", items: missing });

  if (input.nonDeferrableForeignKeys.length > 0) {
    problems.push({ kind: "non_deferrable_foreign_keys", items: [...input.nonDeferrableForeignKeys] });
  }
  if (input.rlsNotForced.length > 0) {
    problems.push({ kind: "rls_not_forced", items: [...input.rlsNotForced] });
  }
  const unprotected = input.workspaceTablesWithoutRls.filter((table) => !exceptions.includes(table));
  if (unprotected.length > 0) problems.push({ kind: "workspace_tables_without_rls", items: unprotected });

  return { ok: problems.length === 0, problems };
}

/**
 * A short, stable identifier for the database checked — never the connection string.
 *
 * Printed so a build log can prove *which* database was checked without
 * exposing its host, role or password.
 */
export function databaseFingerprint(url) {
  try {
    const parsed = new URL(url);
    return createHash("sha256")
      .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "unparseable";
  }
}

/** Removes anything shaped like a connection string before it reaches a log. */
function sanitise(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
  return `${message}${code}`.replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");
}

async function readDatabase(connectionString) {
  // No server-side startup parameters: a transaction pooler rejects unknown
  // ones, which would fail every production deploy for the wrong reason. The
  // statement timeout is set inside the transaction instead.
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const names = async (sql) => (await client.query(sql)).rows.map((row) => row.name);
    const observed = {
      applied: await names(QUERIES.applied),
      nonDeferrableForeignKeys: await names(QUERIES.nonDeferrableForeignKeys),
      rlsNotForced: await names(QUERIES.rlsNotForced),
      workspaceTablesWithoutRls: await names(QUERIES.workspaceTablesWithoutRls),
    };
    await client.query("ROLLBACK");
    return observed;
  } finally {
    await client.end().catch(() => {});
  }
}

const PROBLEM_TEXT = {
  no_shipped_migrations: () => "this build contains no prisma/migrations-postgres directory, so nothing can be checked",
  missing_migrations: (n) => `${n} migration${n === 1 ? "" : "s"} shipped by this commit ${n === 1 ? "is" : "are"} not applied to the database`,
  non_deferrable_foreign_keys: (n) => `${n} foreign key${n === 1 ? " is" : "s are"} not deferrable — a logical restore would fail`,
  rls_not_forced: (n) => `${n} table${n === 1 ? " has" : "s have"} row-level security enabled without FORCE`,
  workspace_tables_without_rls: (n) => `${n} table${n === 1 ? "" : "s"} with a workspaceId column ${n === 1 ? "has" : "have"} no row-level security and ${n === 1 ? "is" : "are"} not a documented exception`,
};

function blocked(reasons) {
  console.log("\nDEPLOYMENT GATE: BLOCKED — this build will not proceed.\n");
  for (const line of reasons) console.log(line);
  console.log(
    "\nThis build never changes the database. Fix it from an operator machine, then redeploy:\n" +
      "  migrations:  node scripts/use-provider.mjs postgresql\n" +
      "               DIRECT_URL=<owner connection> DATABASE_URL=<owner connection> \\\n" +
      "                 npx prisma migrate deploy --config prisma7.config.ts\n" +
      "               node scripts/use-provider.mjs sqlite\n" +
      "  policies:    re-apply prisma/postgres/001–006 in order (docs/RLS.md, \"Applying it\");\n" +
      "               003 makes foreign keys deferrable, 002/004/005 carry row-level security\n" +
      "\nThere is no override. See docs/VERCEL-DEPLOYMENT.md.\n",
  );
  return 1;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const target = process.env.VERCEL_ENV
    ? `${process.env.VERCEL_ENV} build`
    : process.env.VERCEL
      ? "Vercel build"
      : "manual run";
  console.log(`\nDeployment gate — ${target}`);

  if (!/^postgres(ql)?:\/\//.test(url)) {
    return blocked([
      "  ✕ this build has no PostgreSQL DATABASE_URL to check against.",
      "    Every build that runs this command is gated, preview included, and a build with",
      "    nothing to check cannot be proven compatible with anything.",
    ]);
  }

  const shipped = shippedMigrations();
  console.log(`  database fingerprint: ${databaseFingerprint(url)}  (a hash of host and database name)`);

  let observed;
  try {
    observed = await readDatabase(url);
  } catch (error) {
    return blocked([
      `  ✕ could not read the database: ${sanitise(error)}`,
      "    An unreadable database is not evidence of a compatible one.",
    ]);
  }

  console.log(`  migrations:          ${shipped.length} shipped by this commit, ${observed.applied.length} applied in the database`);
  console.log(`  foreign keys:        ${observed.nonDeferrableForeignKeys.length} non-deferrable`);
  console.log(`  row-level security:  ${observed.rlsNotForced.length} enabled without FORCE; ` +
    `${observed.workspaceTablesWithoutRls.filter((t) => !RLS_EXCEPTIONS.includes(t)).length} workspace tables unprotected ` +
    `(documented exceptions: ${RLS_EXCEPTIONS.join(", ")})`);

  const verdict = evaluate({ shipped, ...observed });
  if (!verdict.ok) {
    const lines = [];
    for (const problem of verdict.problems) {
      lines.push(`  ✕ ${PROBLEM_TEXT[problem.kind](problem.items.length)}${problem.items.length ? ":" : ""}`);
      for (const item of problem.items) lines.push(`      ${item}`);
    }
    return blocked(lines);
  }

  console.log("\nDEPLOYMENT GATE: PASSED\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.log(`\nDEPLOYMENT GATE: BLOCKED — unexpected error: ${sanitise(error)}\n`);
      process.exit(1);
    },
  );
}
