#!/usr/bin/env node
/**
 * Runs the whole suite against a real PostgreSQL server.
 *
 * Uses `DATABASE_URL` when one is set (CI's service container); otherwise starts
 * the embedded PostgreSQL 17 cluster from scripts/pg.mjs, so a developer with
 * no Docker can still verify against the engine production actually runs.
 *
 *   npm run test:pg
 *   npm run test:pg -- "tests/security/**\/*.test.ts"
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const node = (args, options = {}) =>
  execFileSync("node", args, { cwd: ROOT, encoding: "utf8", stdio: "inherit", ...options });

let DATABASE_URL = process.env.DATABASE_URL;
const managed = !DATABASE_URL;

if (managed) {
  node(["scripts/pg.mjs", "start"]);
  DATABASE_URL = execFileSync("node", ["scripts/pg.mjs", "url"], { cwd: ROOT, encoding: "utf8" }).trim();
  // A clean database per run, so a leftover row cannot make a test pass.
  node(["scripts/pg.mjs", "reset"]);
} else if (!/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
  console.error(`DATABASE_URL is not a PostgreSQL URL: ${DATABASE_URL}`);
  process.exit(2);
}

const env = { ...process.env, DATABASE_URL };

console.log("\nSwitching the datasource to PostgreSQL…");
node(["scripts/use-provider.mjs", "postgresql"]);

let status = 1;
try {
  execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "inherit", env });
  execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: ROOT, stdio: "inherit", env });
  node(["scripts/apply-sql.mjs", "prisma/postgres/001_search_indexes.sql"], { env });
  node(["scripts/apply-sql.mjs", "prisma/postgres/002_row_level_security.sql"], { env });
  node(["scripts/apply-sql.mjs", "prisma/postgres/003_deferrable_constraints.sql"], { env });
  node(["scripts/apply-sql.mjs", "prisma/postgres/004_workspace_bootstrap.sql"], { env });
  node(["scripts/apply-sql.mjs", "prisma/postgres/005_identity_policies.sql"], { env });
  node(["scripts/apply-sql.mjs", "prisma/postgres/006_job_claim.sql"], { env });

  // The RLS tests need a connection as the restricted role. When this script
  // manages the cluster it can provision one; against an external server the
  // operator supplies RLS_APP_DATABASE_URL, and the tests skip without it.
  if (managed) {
    node(["scripts/pg.mjs", "app-role"]);
    env.RLS_APP_DATABASE_URL = execFileSync("node", ["scripts/pg.mjs", "app-url"], {
      cwd: ROOT, encoding: "utf8",
    }).trim();
  }

  // The split that makes these tests mean anything.
  //
  // Everything above — migrations, the SQL files, seeding — is maintenance and
  // runs as the owner. The *application under test* must connect as the
  // restricted role, or FORCE ROW LEVEL SECURITY does not bind it and every RLS
  // assertion passes vacuously. That is exactly what was happening: this script
  // and CI both ran the whole suite as the superuser.
  //
  // The fixtures keep the owner connection, because a harness bound by the same
  // policies cannot tell a refused attack from a broken application.
  const adminUrl = env.DATABASE_URL;
  env.FIXTURE_DATABASE_URL = adminUrl;
  if (env.RLS_APP_DATABASE_URL) {
    env.DATABASE_URL = env.RLS_APP_DATABASE_URL;
  } else {
    console.warn(
      "\nNo RLS_APP_DATABASE_URL: the suite will run as the owner, and every\n" +
        "row-level-security assertion will be vacuous. tests/security/rls-runtime\n" +
        "asserts the connection is unprivileged and will fail, which is intended.\n",
    );
  }

  const pattern = process.argv[2] ?? "tests/**/*.test.ts";
  const result = spawnSync(
    "npx",
    ["tsx", "--test", "--test-reporter=spec", "--test-concurrency=1", pattern],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...env,
        NODE_ENV: "test",
        AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
      },
    },
  );
  status = result.status ?? 1;
} finally {
  // Always restore SQLite, or the next `npm test` runs against a schema whose
  // provider no longer matches its migration history.
  console.log("\nRestoring the SQLite datasource…");
  node(["scripts/use-provider.mjs", "sqlite"]);
  execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "inherit" });
}

process.exit(status);
