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

async function waitForServer() {
  const deadline = Date.now() + 180_000;
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
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(serverLog);
  throw new Error("the dev server did not become ready within 180s");
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
if (result.status !== 0) console.error("\n--- last of the server log ---\n" + serverLog.slice(-4000));
process.exit(result.status ?? 1);
