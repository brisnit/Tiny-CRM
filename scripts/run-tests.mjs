#!/usr/bin/env node
/**
 * Test runner.
 *
 * Creates a throwaway SQLite database, applies migrations, then runs the suites
 * with NODE_ENV=test — which is what unlocks the in-process identity hook used
 * to act as a specific user without a browser (see src/lib/auth/context.ts).
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DB = resolve(process.cwd(), "test.db");
const DATABASE_URL = `file:${TEST_DB}`;

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const file = `${TEST_DB}${suffix}`;
  if (existsSync(file)) unlinkSync(file);
}

console.log("Preparing test database…");
execSync("npx prisma migrate deploy", {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL },
});

// tests/browser is deliberately excluded: those suites need the application
// running and a Chromium to drive it, which `npm run test:browser` sets up.
const pattern = process.argv[2] ?? "tests/{unit,integration,security,portability}/**/*.test.ts";

const result = spawnSync(
  "npx",
  [
    "tsx",
    "--test",
    "--test-reporter=spec",
    ...(process.env.TEST_CONCURRENCY ? [] : ["--test-concurrency=1"]),
    pattern,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL,
      NODE_ENV: "test",
      AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      // Neutralise the `server-only` import guard for in-process tests.
      // A relative path, because NODE_OPTIONS cannot express a path containing
      // spaces and this project may live under one.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
    },
  },
);

process.exit(result.status ?? 1);
