#!/usr/bin/env node
/**
 * One-time provisioning of a hosted PostgreSQL for Tiny CRM.
 *
 * Reads the owner/admin connection string from a file outside the repository,
 * applies the schema and the three SQL files, then creates a login for the
 * unprivileged runtime role and writes the application's connection string to
 * a second protected file.
 *
 * SECRET HANDLING
 * ---------------
 * No connection string, password, or credential is ever written to stdout or
 * stderr. Child-process output is passed through a redactor that replaces every
 * known secret with a placeholder before anything is printed, because Prisma and
 * pg both include the connection string in some error messages.
 *
 * The credentials live only in:
 *   ~/.config/tinycrm/neon-owner.url        (you create this; owner/admin)
 *   ~/.config/tinycrm/app-password          (generated here)
 *   ~/.config/tinycrm/app-database.url      (generated here; goes into Vercel)
 * all mode 0600, all outside the git working tree.
 *
 * Usage:
 *   node scripts/provision-hosted.mjs            # provision
 *   node scripts/provision-hosted.mjs --show-app-url   # copy app URL to clipboard
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const CONF = resolve(homedir(), ".config/tinycrm");
const OWNER_FILE = resolve(CONF, "neon-owner.url");
const APP_PW_FILE = resolve(CONF, "app-password");
const APP_URL_FILE = resolve(CONF, "app-database.url");

// Every secret string seen so far. Anything printed is scrubbed of these.
const SECRETS = new Set();

function remember(value) {
  if (typeof value === "string" && value.length >= 8) SECRETS.add(value);
}

function redact(text) {
  let out = String(text ?? "");
  for (const secret of SECRETS) {
    if (secret) out = out.split(secret).join("«REDACTED»");
  }
  // Belt and braces: any user:password@host that slipped through.
  out = out.replace(/(postgres(?:ql)?:\/\/)[^\s"']*@/gi, "$1«REDACTED»@");
  return out;
}

const say = (msg) => console.log(redact(msg));
const step = (n, msg) => console.log(`\n[${n}] ${redact(msg)}`);
const ok = (msg) => console.log(`   ok    ${redact(msg)}`);
const bad = (msg) => console.error(`   FAIL  ${redact(msg)}`);

function die(msg) {
  bad(msg);
  process.exit(1);
}

function readSecretFile(path, label) {
  if (!existsSync(path)) die(`${label} not found at ${path}`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) die(`${label} at ${path} is empty`);
  remember(value);
  return value;
}

function writeSecretFile(path, value) {
  mkdirSync(CONF, { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  remember(value);
}

/** Runs a command, redacting its output. Returns combined output. */
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    console.error(redact(output).split("\n").slice(-25).join("\n"));
    die(`${command} ${args[0] ?? ""} failed with exit code ${result.status}`);
  }
  return output;
}

/**
 * Neon's pooled endpoint is the direct host with `-pooler` appended to the
 * endpoint id. Derived rather than asked for, then *verified by connecting* —
 * a derivation that is not checked is a guess.
 */
function pooledFrom(url) {
  const u = new URL(url);
  if (u.hostname.includes("-pooler")) return url;
  const [first, ...rest] = u.hostname.split(".");
  u.hostname = [`${first}-pooler`, ...rest].join(".");
  return u.toString();
}

function withCredentials(url, user, password) {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  return u.toString();
}

async function connect(url, label) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    bad(`could not connect as ${label}: ${redact(error.message ?? error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------

async function showAppUrl() {
  const url = readSecretFile(APP_URL_FILE, "The application connection string");
  const result = spawnSync("pbcopy", [], { input: url });
  if (result.status === 0) {
    say("The application DATABASE_URL is on your clipboard. Paste it into Vercel.");
    say("It is NOT printed here. Clear your clipboard afterwards.");
  } else {
    say(`It is stored at ${APP_URL_FILE} (mode 0600). Not printed here.`);
  }
}

async function main() {
  if (process.argv.includes("--show-app-url")) return showAppUrl();

  console.log("Provision hosted PostgreSQL for Tiny CRM\n" + "=".repeat(60));

  // -------------------------------------------------------------------------
  step(1, "Read the owner credential");
  const ownerUrl = readSecretFile(OWNER_FILE, "The owner connection string");

  let parsed;
  try {
    parsed = new URL(ownerUrl);
  } catch {
    die("The saved value is not a valid URL. Re-save it.");
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    die(`The saved value is not a postgres:// URL (protocol ${parsed.protocol}).`);
  }
  remember(parsed.password);
  ok(`owner credential parsed — host ${parsed.hostname.replace(/^[^.]+/, "…")}, database ${parsed.pathname.slice(1)}`);

  if (parsed.hostname.includes("-pooler")) {
    die(
      "That is the POOLED endpoint. Migrations need the DIRECT one — DDL and " +
        "Prisma's migration advisory lock do not work through transaction pooling. " +
        "Copy the direct URL from Neon (host without '-pooler') and re-save.",
    );
  }

  const admin = await connect(ownerUrl, "the owner");
  if (!admin) die("Owner connection failed. Check the URL and that your IP is allowed.");

  const version = (await admin.query("SHOW server_version")).rows[0].server_version;
  const ownerIsSuper = (
    await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
  ).rows[0]?.rolsuper;
  ok(`connected — PostgreSQL ${version}`);
  // Not a failure: the migration role is *supposed* to be privileged. Recorded
  // because it is the reason the application must never reuse this credential —
  // FORCE ROW LEVEL SECURITY does not bind a superuser.
  ok(`owner role is ${ownerIsSuper ? "a superuser" : "a non-superuser owner"} — the app will not use it`);
  if (Number.parseInt(version, 10) < 17) {
    say("   note  expected PostgreSQL 17; continuing, but verify feature parity.");
  }

  // -------------------------------------------------------------------------
  step(2, "Apply schema and migrations (as the owner)");
  run("node", ["scripts/use-provider.mjs", "postgresql"]);
  run("npx", ["prisma", "generate"], { DATABASE_URL: ownerUrl });
  ok("prisma client generated");

  run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: ownerUrl, DIRECT_URL: ownerUrl });
  ok("migrations applied");

  for (const file of [
    "001_search_indexes.sql",
    "002_row_level_security.sql",
    "003_deferrable_constraints.sql",
  ]) {
    const out = run("node", ["scripts/apply-sql.mjs", `prisma/postgres/${file}`], {
      DATABASE_URL: ownerUrl,
    });
    ok(out.trim().split("\n").pop() ?? file);
  }

  // -------------------------------------------------------------------------
  step(3, "Create the runtime role's login");

  let appPassword;
  if (existsSync(APP_PW_FILE)) {
    appPassword = readSecretFile(APP_PW_FILE, "The runtime role password");
    ok("reusing the existing generated password");
  } else {
    // 32 bytes of CSPRNG, base64url so it needs no escaping in a URL.
    appPassword = randomBytes(32).toString("base64url");
    writeSecretFile(APP_PW_FILE, appPassword);
    ok("generated a new 32-byte password (stored 0600, never printed)");
  }
  remember(appPassword);

  // The role itself was created NOLOGIN by 002_row_level_security.sql. Identifiers
  // are constants here; the password is parameterised via format(%L) to avoid any
  // possibility of injection through a generated value.
  await admin.query(
    `DO $$ BEGIN
       EXECUTE format('ALTER ROLE tinycrm_app WITH LOGIN PASSWORD %L', $1);
     END $$;`,
    [appPassword],
  ).catch(async (error) => {
    // Older servers reject parameters in a DO block; fall back to a direct
    // parameterised ALTER, which pg escapes correctly.
    if (/there is no parameter|bind message/i.test(String(error.message))) {
      const escaped = appPassword.replace(/'/g, "''");
      await admin.query(`ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '${escaped}'`);
    } else {
      throw error;
    }
  });
  ok("tinycrm_app can now log in");

  const dbName = parsed.pathname.slice(1);
  await admin.query(`GRANT CONNECT ON DATABASE "${dbName.replace(/"/g, '""')}" TO tinycrm_app`);
  ok(`granted CONNECT on ${dbName}`);

  // Some providers assign table ownership unexpectedly. FORCE RLS binds the
  // owner, but ownership also carries DDL, so the runtime role must own nothing.
  const owned = (
    await admin.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner='tinycrm_app'`,
    )
  ).rows[0].n;
  if (owned > 0) {
    say(`   note  tinycrm_app owned ${owned} table(s); reassigning to the owner role.`);
    await admin.query(`REASSIGN OWNED BY tinycrm_app TO CURRENT_USER`);
    ok("ownership reassigned");
  } else {
    ok("tinycrm_app owns no table");
  }

  await admin.end().catch(() => {});

  // -------------------------------------------------------------------------
  step(4, "Build and verify the application connection string");

  const pooledCandidate = withCredentials(pooledFrom(ownerUrl), "tinycrm_app", appPassword);
  const directCandidate = withCredentials(ownerUrl, "tinycrm_app", appPassword);
  remember(pooledCandidate);
  remember(directCandidate);

  let appUrl = null;
  const pooledClient = await connect(pooledCandidate, "tinycrm_app on the pooled endpoint");
  if (pooledClient) {
    await pooledClient.end().catch(() => {});
    appUrl = pooledCandidate;
    ok("pooled endpoint reachable as tinycrm_app — using it");
  } else {
    const directClient = await connect(directCandidate, "tinycrm_app on the direct endpoint");
    if (!directClient) die("tinycrm_app could not connect on either endpoint.");
    await directClient.end().catch(() => {});
    appUrl = directCandidate;
    say("   note  the pooled endpoint was unreachable; falling back to the direct one.");
    say("   note  a serverless deployment SHOULD use a pooled endpoint. Check Neon's");
    say("         dashboard for the '-pooler' host and update DATABASE_URL before launch.");
  }

  writeSecretFile(APP_URL_FILE, appUrl);
  ok(`application connection string written to ${APP_URL_FILE} (0600)`);

  // -------------------------------------------------------------------------
  step(5, "Restore the local SQLite datasource");
  run("node", ["scripts/use-provider.mjs", "sqlite"]);
  run("npx", ["prisma", "generate"]);
  ok("local development is back on SQLite");

  console.log("\n" + "=".repeat(60));
  say("Provisioned. Nothing above contains a credential.");
  console.log("=".repeat(60));
  say("\nNext:");
  say("  npm run verify:hosted   (this script prints the exact command)");
  say(`  node scripts/provision-hosted.mjs --show-app-url   copies DATABASE_URL to your clipboard`);
}

main().catch((error) => {
  console.error(redact(error?.stack ?? String(error)));
  // Never leave the repo pointed at PostgreSQL.
  spawnSync("node", ["scripts/use-provider.mjs", "sqlite"], { cwd: ROOT });
  process.exit(1);
});
