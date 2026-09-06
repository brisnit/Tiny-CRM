/**
 * Test bootstrap.
 *
 * Runs each suite against a disposable SQLite database so tests never touch a
 * developer's working data, and neutralises the `server-only` guard that would
 * otherwise refuse to load the data layer outside Next.
 */
import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DB = resolve(process.cwd(), "test.db");

export function prepareTestDatabase() {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const file = `${TEST_DB}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
  });
}

if (process.argv[1]?.endsWith("setup.ts")) prepareTestDatabase();
