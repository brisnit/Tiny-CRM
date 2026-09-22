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
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { storageEnvFor } from "./storage-env.mjs";

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

// Object storage, when one can be provided. The Documents suite skips without
// it; every other browser suite is unaffected.
const storage = await storageEnvFor();

const serverEnv = {
  ...process.env,
  ...storage,
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
 * Says why the harness failed, somewhere a failure can actually be read.
 *
 * CI logs on this repository cannot be read without admin access. GitHub turns
 * `::error::` workflow commands into annotations, and annotations *are* readable
 * from the public API, so on failure the harness states its own cause there:
 * the tail of the test runner's output and of the dev server's log.
 *
 * That text leaves the machine, so it is sanitised by shape rather than by
 * trusting every call site to have been careful — a Playwright error can carry
 * an invite URL, an assertion can carry a generated address, and a stack can
 * carry a connection string.
 */
function sanitise(text) {
  return String(text)
    .replace(/postgres(ql)?:\/\/[^\s"']+/g, "[connection string redacted]")
    .replace(/file:[^\s"']+/g, "[sqlite path redacted]")
    .replace(/\/invite\/[A-Za-z0-9_-]+/g, "/invite/[token redacted]")
    .replace(/[?&](token|code|secret|key)=[^\s&"']+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(/(secret|token|key|password|cookie|session)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

function annotate(title, detail) {
  if (!process.env.GITHUB_ACTIONS) return;
  const safe = sanitise(String(detail))
    .slice(-6000)
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
        await warmRoutes();
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

/**
 * Compiles each public route the suites drive before any test runs.
 *
 * Next's dev server compiles a route on its first request, and that cost does
 * not belong inside a test's timeout. Best-effort: a route that is slow to
 * compile here is simply compiled again by the test that needs it.
 * The authenticated routes cannot be warmed with a plain fetch — they sit
 * behind the signed-out redirect — so they are warmed with a real session
 * below, once the server is ready.
 */
const WARM_ROUTES = ["/login", "/signup", "/invite/warmup"];

async function warmRoutes() {
  for (const route of WARM_ROUTES) {
    await fetch(`${BASE_URL}${route}`, { signal: AbortSignal.timeout(120_000) }).catch(() => {});
  }
}

await waitForServer();

/**
 * Compiles the authenticated routes, with a real session, before any suite runs.
 *
 * Here and not in a suite's before(): the runner's --test-timeout bounds a whole
 * test file, hooks included, so a suite can never give the first signed-in
 * compile more than 120 seconds. On a CI runner that was not enough twice
 * (1e356cc, a9dfdb8). Spawned, never spawnSync, for the reason given at the
 * runner below. Best-effort and bounded; its step timings are kept so a failure
 * annotation can say where the time went.
 */
const WARM_AUTH_BUDGET_MS = 900_000;
let warmLog = "";
console.log("Warming the authenticated routes…");
await new Promise((resolveWarm) => {
  const warm = spawn("npx", ["tsx", "tests/browser/support/warm-authenticated-routes.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...storage,
      DATABASE_URL,
      BASE_URL,
      NODE_ENV: "test",
      AUTH_SECRET: serverEnv.AUTH_SECRET,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
    },
  });
  const timer = setTimeout(() => {
    warmLog += `  warm-up: gave up after ${WARM_AUTH_BUDGET_MS / 1000}s\n`;
    warm.kill("SIGTERM");
  }, WARM_AUTH_BUDGET_MS);
  for (const stream of [warm.stdout, warm.stderr]) {
    stream.on("data", (chunk) => {
      process.stdout.write(chunk);
      warmLog = (warmLog + chunk.toString()).slice(-4000);
    });
  }
  warm.on("close", () => { clearTimeout(timer); resolveWarm(); });
  warm.on("error", () => { clearTimeout(timer); resolveWarm(); });
});

console.log("Ready. Running the browser suites…\n");

/**
 * The test runner, streamed live and also kept.
 *
 * `spawn`, never `spawnSync`. This is load-bearing, and it was found the hard
 * way: every CI run that used spawnSync here failed the browser job (f63c555,
 * 918b1bc, 8404507, 25dd15c), the first run with async spawn passed (2720940),
 * and a control that reintroduced spawnSync and changed nothing else failed
 * again (3a24667).
 *
 * The reason is this process's own event loop. spawnSync blocks it for the
 * whole test run, and the dev server's stdout and stderr are pipes drained by
 * `data` handlers on that loop — so while tests run, nothing drains them. The
 * dev server writes to stdout continuously: a line per request, and in
 * development the mail sink prints every email in full. Once the OS pipe buffer
 * is full, the server blocks inside its next write and the request it was
 * serving never returns. In the control run 22 tests passed first; the stall
 * landed in an invite sign-up, which sends a verification email at exactly that
 * moment, and the test then waited 60 seconds for a page that never came back.
 * That fits every observation; the blocked write itself was not captured.
 *
 * Two traps for whoever reads a failure here next. Under spawnSync the in-memory
 * `serverLog` cannot grow during the run either, so a server log that goes
 * silent is an artifact of the blocked loop, not evidence that no request
 * arrived — that exact misreading cost a diagnostic round. And streaming the
 * runner's output live does not make it safe to block: the server's pipes need
 * the loop too.
 *
 * Output is kept as well as streamed so a failure can be explained in the
 * GitHub annotation below.
 */
let runnerLog = "";

const runner = spawn(
  "npx",
  [
    "tsx",
    "--test",
    "--test-reporter=spec",
    "--test-concurrency=1",
    // A hung test fails as a test instead of starving the job in silence.
    // Generous: the slowest of these takes about five seconds.
    "--test-timeout=120000",
    process.argv[2] ?? "tests/browser/**/*.test.ts",
  ],
  {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      ...storage,
      DATABASE_URL,
      BASE_URL,
      NODE_ENV: "test",
      AUTH_SECRET: serverEnv.AUTH_SECRET,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
    },
  },
);

for (const [name, stream] of [["stdout", runner.stdout], ["stderr", runner.stderr]]) {
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    (name === "stdout" ? process.stdout : process.stderr).write(text);
    runnerLog += text;
    if (runnerLog.length > 200_000) runnerLog = runnerLog.slice(-200_000);
  });
}

const status = await new Promise((resolve) => {
  runner.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  runner.on("error", (error) => {
    runnerLog += `\nspawn error: ${error.name}: ${error.message}\n`;
    resolve(1);
  });
});

shutdown();

if (status !== 0) {
  console.error("\n--- last of the server log ---\n" + serverLog.slice(-4000));
  annotate(
    "browser suites failed",
    [
      `runner exit status: ${status}`,
      "",
      "authenticated warm-up:",
      warmLog.trim() || "  (no output)",
      "",
      "runner output tail:",
      runnerLog.slice(-3500),
      "",
      "server log tail:",
      serverLog.slice(-2000),
    ].join("\n"),
  );
}

process.exit(status);
