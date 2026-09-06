#!/usr/bin/env node
/**
 * Runs the performance regression suite against a throwaway database, so a
 * timing run can never touch development or production data.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const DB = resolve(process.cwd(), "perf.db");
const DATABASE_URL = `file:${DB}`;

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const file = `${DB}${suffix}`;
  if (existsSync(file)) unlinkSync(file);
}

execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL } });

const result = spawnSync("npx", ["tsx", "scripts/perf-regression.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL,
    NODE_ENV: "test",
    AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/allow-server-modules.cjs`.trim(),
  },
});

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const file = `${DB}${suffix}`;
  if (existsSync(file)) unlinkSync(file);
}

process.exit(result.status ?? 1);
