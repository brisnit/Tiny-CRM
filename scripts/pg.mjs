#!/usr/bin/env node
/**
 * A real PostgreSQL 17 server, for verification runs.
 *
 * This machine has no Docker, no Homebrew and no system PostgreSQL. Rather than
 * declare portability "argued but not proven" a second time, this starts an
 * actual `postgres` process from the binaries shipped in
 * `@embedded-postgres/darwin-arm64` — the same upstream builds Zonky publishes
 * for the JVM's embedded-postgres, not a mock or an emulation.
 *
 *   node scripts/pg.mjs start    # initdb + start on PGPORT (default 55432)
 *   node scripts/pg.mjs stop
 *   node scripts/pg.mjs status
 *   node scripts/pg.mjs url      # prints the connection string
 *   node scripts/pg.mjs reset    # drop and recreate the database
 *   node scripts/pg.mjs psql "SELECT 1"   # these builds ship no psql binary
 *
 * The cluster lives under .pgdata/, which is git-ignored. Nothing here is used
 * in production: production points DATABASE_URL at a managed server.
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = resolve(import.meta.dirname, "..");
const DATA = resolve(ROOT, ".pgdata");
const RUN = resolve(ROOT, ".pgdata-run");
const PORT = Number(process.env.PGPORT ?? 55432);
const USER = "tinycrm";
const PASSWORD = "tinycrm";
const DATABASE = process.env.PGDATABASE ?? "tinycrm_test";

/**
 * The Unix socket directory must not contain a space or a `%`, and must stay
 * well under the platform's ~100-character sockaddr limit. The repository path
 * satisfies neither reliably, so sockets live under the system temp directory.
 */
const SOCKET_DIR = resolve(tmpdir(), "tinycrm-pg");

/**
 * Locates the platform binaries that npm installed.
 *
 * Resolved by path rather than by `require.resolve`: the package declares an
 * `exports` map that does not include `package.json`, so resolution through the
 * module system fails even though the files are present.
 */
function binDir() {
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  const candidate = resolve(ROOT, "node_modules", pkg, "native/bin");
  if (existsSync(resolve(candidate, "postgres"))) return candidate;

  console.error(
    `No PostgreSQL binaries for ${process.platform}-${process.arch}.\n` +
      `Install them with:  npm i -D ${pkg}\n` +
      `Or point DATABASE_URL at a PostgreSQL server you already have.`,
  );
  process.exit(2);
}

const BIN = binDir();
const bin = (name) => resolve(BIN, name);

export const CONNECTION_URL =
  `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;

/**
 * The RLS-restricted role. `USER` above is the cluster's bootstrap superuser,
 * and **a superuser bypasses row-level security even when a table is marked
 * FORCE ROW LEVEL SECURITY** — so a verification run that connects as it proves
 * nothing about the policies. This is the connection the RLS tests use.
 */
const APP_PASSWORD = "tinycrm_app";
export const APP_URL =
  `postgresql://tinycrm_app:${APP_PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function isRunning() {
  return run(bin("pg_ctl"), ["-D", DATA, "status"]).status === 0;
}

async function connect(database = "postgres") {
  const { Client } = require("pg");
  const client = new Client({
    host: "127.0.0.1", port: PORT, user: USER, password: PASSWORD, database,
  });
  await client.connect();
  return client;
}

async function ensureDatabase() {
  const client = await connect("postgres");
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (existing.rowCount === 0) {
      // Identifiers cannot be parameterised; DATABASE is a constant in this file,
      // never user input.
      await client.query(`CREATE DATABASE "${DATABASE}"`);
    }
  } finally {
    await client.end();
  }
}

async function start() {
  if (isRunning()) {
    await ensureDatabase();
    console.log(`Already running on port ${PORT}.`);
    console.log(CONNECTION_URL);
    return;
  }

  mkdirSync(SOCKET_DIR, { recursive: true });

  if (!existsSync(DATA)) {
    mkdirSync(RUN, { recursive: true });
    const passwordFile = resolve(RUN, "pwfile");
    writeFileSync(passwordFile, PASSWORD, { mode: 0o600 });

    console.log("Initialising a PostgreSQL 17 cluster…");
    const init = run(bin("initdb"), [
      "-D", DATA,
      "-U", USER,
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      // A deterministic collation, so a case-sensitivity finding is a property
      // of PostgreSQL rather than of this laptop's locale.
      "--locale=C",
    ]);
    rmSync(passwordFile, { force: true });
    if (init.status !== 0) {
      console.error(init.stdout + init.stderr);
      process.exit(1);
    }

    // Settings go in the config file, not in `pg_ctl -o`. That option is a
    // single string that postgres word-splits, so any path containing a space —
    // and this project's own directory contains one — arrives truncated.
    appendFileSync(
      resolve(DATA, "postgresql.conf"),
      [
        "",
        "# Written by scripts/pg.mjs — verification cluster, not production.",
        `port = ${PORT}`,
        "listen_addresses = '127.0.0.1'",
        `unix_socket_directories = '${SOCKET_DIR}'`,
        "fsync = off",
        "synchronous_commit = off",
        "full_page_writes = off",
        "",
      ].join("\n"),
    );
  }

  console.log(`Starting PostgreSQL on port ${PORT}…`);
  const start = run(bin("pg_ctl"), [
    "-D", DATA,
    "-l", resolve(RUN, "postgres.log"),
    "-w", "-t", "60",
    "start",
  ]);
  if (start.status !== 0) {
    console.error(start.stdout + start.stderr);
    process.exit(1);
  }

  await ensureDatabase();
  console.log(run(bin("postgres"), ["--version"]).stdout.trim());
  console.log(CONNECTION_URL);
}

function stop() {
  if (!isRunning()) {
    console.log("Not running.");
    return;
  }
  const result = run(bin("pg_ctl"), ["-D", DATA, "-m", "fast", "-w", "stop"]);
  console.log(result.status === 0 ? "Stopped." : result.stdout + result.stderr);
}

async function reset() {
  if (!isRunning()) await start();
  const client = await connect("postgres");
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE],
    );
    await client.query(`DROP DATABASE IF EXISTS "${DATABASE}"`);
    await client.query(`CREATE DATABASE "${DATABASE}"`);
  } finally {
    await client.end();
  }
  console.log(`Recreated ${DATABASE}.`);
}

/**
 * Gives the RLS-restricted role a login for verification runs.
 *
 * The migration creates `tinycrm_app` with NOLOGIN and no password on purpose —
 * a credential in a migration file is a credential in version control. This sets
 * one for the local verification cluster only.
 *
 * The password is deliberately the same well-known value as the cluster's own:
 * this database is a throwaway on 127.0.0.1 that holds no real data.
 */
async function appRole() {
  const client = await connect(DATABASE);
  try {
    await client.query(`ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
    await client.query(`GRANT CONNECT ON DATABASE "${DATABASE}" TO tinycrm_app`);
    console.log(APP_URL);
  } finally {
    await client.end();
  }
}

/** These builds ship no psql, so this is the substitute for one-off SQL. */
async function sql(statement) {
  const client = await connect(DATABASE);
  try {
    const result = await client.query(statement);
    if (result.rows?.length) console.table(result.rows);
    else console.log(`${result.command} ${result.rowCount ?? ""}`.trim());
  } finally {
    await client.end();
  }
}

const [, , command, ...rest] = process.argv;

switch (command) {
  case "start": await start(); break;
  case "stop": stop(); break;
  case "reset": await reset(); break;
  case "status": console.log(isRunning() ? `running on ${PORT}` : "stopped"); break;
  case "url": console.log(CONNECTION_URL); break;
  case "app-url": console.log(APP_URL); break;
  case "app-role": await appRole(); break;
  case "psql": await sql(rest.join(" ")); break;
  case "destroy":
    stop();
    rmSync(DATA, { recursive: true, force: true });
    rmSync(RUN, { recursive: true, force: true });
    console.log("Cluster removed.");
    break;
  default:
    console.log("Usage: node scripts/pg.mjs <start|stop|reset|status|url|app-url|app-role|psql|destroy>");
    process.exit(1);
}
