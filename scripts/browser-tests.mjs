#!/usr/bin/env node
/**
 * Browser regression harness.
 *
 * Some of this product's defects only exist in a real browser. The password
 * reset loop was one: it came from React's input reconciliation racing a
 * password manager's DOM write, and no amount of server-side or JSDOM testing
 * could see it. Two consecutive fixes shipped on reasoning alone and each
 * introduced the next regression, so the behaviour now has an actual browser
 * standing behind it.
 *
 * Starts the app on a throwaway SQLite database, runs the suites in
 * tests/browser against it in Chromium, and tears both down.
 *
 *   npm run test:browser
 *
 * `next dev` rather than a production build: the production configuration gate
 * refuses SQLite and an in-process rate limiter, which is correct of it, and
 * React's input reconciliation — the thing under test — is identical either way.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.BROWSER_TEST_PORT ?? 3123);
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB = resolve(process.cwd(), "browser-test.db");
const DATABASE_URL = `file:${TEST_DB}`;

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const file = `${TEST_DB}${suffix}`;
  if (existsSync(file)) unlinkSync(file);
}

console.log("Preparing the browser test database…");
execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL } });

/**
 * Write-ahead logging, because two processes share this file.
 *
 * The suite is unusual in that the *test* process writes the database (fixtures
 * creating accounts and workspaces) while the *dev server* writes it too
 * (sessions, audit rows, whatever the page under test does). SQLite's default
 * rollback journal gives a writer an exclusive lock on the whole database, so
 * those two collide — intermittently, under load, and nowhere else in the
 * suite, because this is the only harness with two writers.
 *
 * It showed up exactly as you would expect and exactly as it is easy to
 * misread: one local run where a single test took 298 seconds and passed, one
 * that failed, one clean, and a red browser job in CI. The temptation is to
 * raise a timeout. The cause is the lock.
 *
 * In WAL mode readers never block the writer and the writer never blocks
 * readers; only two concurrent writers contend, briefly. `journal_mode` is
 * stored in the file header, so setting it once here applies to every
 * connection that opens it afterwards — both processes.
 *
 * Local to this harness. Production is PostgreSQL and unaffected.
 */
{
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const handle = new Database(TEST_DB);
  const mode = handle.pragma("journal_mode = WAL", { simple: true });
  handle.pragma("busy_timeout = 15000");
  handle.close();
  if (mode !== "wal") {
    console.error(`Could not enable WAL on the test database (mode is "${mode}").`);
    process.exit(1);
  }
  console.log("Test database is in WAL mode.");
}

const serverEnv = {
  ...process.env,
  DATABASE_URL,
  AUTH_SECRET: "browser-test-secret-that-is-at-least-32-characters-long",
  APP_URL: BASE_URL,
  // No mail provider is configured, so the reset notification falls through to
  // the logging adapter. That is deliberate: a test must not send real email.
  NODE_ENV: "development",
};

console.log(`Starting the app on ${BASE_URL}…`);
const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    serverLog += chunk.toString();
    if (serverLog.length > 40_000) serverLog = serverLog.slice(-40_000);
  });
}

function shutdown() {
  if (!server.killed) server.kill("SIGTERM");
}
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(130); });


/**
 * Says what went wrong somewhere a failure can actually be read.
 *
 * CI logs on this repository are not readable without admin access — two
 * browser-job failures were diagnosed by elimination because of it, which is
 * slow and guesses more than it proves. GitHub turns `::error::` workflow
 * commands into annotations, and annotations *are* readable from the public
 * API, so the harness now states its own cause of death there.
 *
 * Newlines must be encoded; the message is capped so a runaway log cannot
 * become the annotation. Connection strings are stripped rather than trusted
 * to be absent — this text leaves the machine.
 */
function annotate(title, detail) {
  if (!process.env.GITHUB_ACTIONS) return;
  const safe = String(detail)
    .replace(/postgres(ql)?:\/\/[^\s"']+/g, "[connection string redacted]")
    .replace(/(secret|token|key|password)[=:]\S+/gi, "$1=[redacted]")
    .slice(-3000)
    .replace(/%/g, "%25")
    .replace(/\r/g, "")
    .replace(/\n/g, "%0A");
  console.log(`::error title=${title}::${safe}`);
}

/**
 * How long the dev server gets to answer its first request.
 *
 * Generous on purpose. A healthy server returns in seconds and never touches
 * this, so the only thing a large budget costs is the time a genuinely broken
 * run takes to give up — and the only thing a small one buys is a red build on
 * a slow machine. CI runners are slower than any development machine here, and
 * they compile Next from an empty cache every time.
 */
const READY_BUDGET_MS = 420_000;

async function waitForServer() {
  const deadline = Date.now() + READY_BUDGET_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      console.error(serverLog);
      throw new Error(`the dev server exited with ${server.exitCode} before it was ready`);
    }
    try {
      // A page route, not just the port: dev compiles on first request, and the
      // suite should not pay that cost inside a test's timeout.
      const response = await fetch(`${BASE_URL}/reset-password?token=warmup`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) {
        // Every other public route the suites drive, for the same reason. A
        // route compiled inside a locator's timeout is a flake waiting for a
        // slow machine; CI is a slow machine.
        for (const route of ["/login", "/signup", "/invite/warmup"]) {
          await fetch(`${BASE_URL}${route}`, { signal: AbortSignal.timeout(120_000) }).catch(
            () => {},
          );
        }
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(serverLog);
  annotate(
    "browser harness: the dev server never became ready",
    `Waited ${Math.round(READY_BUDGET_MS / 1000)}s for ${BASE_URL}/reset-password to answer.\n` +
      `Last of the server log:\n${serverLog.slice(-2500)}`,
  );
  throw new Error(`the dev server did not become ready within ${READY_BUDGET_MS}ms`);
}

await waitForServer();
console.log("Ready. Running the browser suites…\n");

const result = spawnSync(
  "npx",
  ["tsx", "--test", "--test-reporter=spec", "--test-concurrency=1", "tests/browser/**/*.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL,
      BASE_URL,
      NODE_ENV: "test",
      AUTH_SECRET: serverEnv.AUTH_SECRET,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
    },
  },
);

shutdown();
if (result.status !== 0) {
  console.error("\n--- last of the server log ---\n" + serverLog.slice(-4000));
  annotate("browser suites failed", `Last of the server log:\n${serverLog.slice(-2500)}`);
}
process.exit(result.status ?? 1);
