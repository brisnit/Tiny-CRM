import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Which builds may proceed without a database.
 *
 * This script runs immediately after the deployment gate in `vercel.json`'s
 * build command, and the two must agree about one narrow case: a preview build
 * given no DATABASE_URL. The gate skips it; this leaves the committed provider
 * alone so the build can continue. If only one of them allowed it, a preview
 * would still fail — and if this one were laxer than the gate, a production
 * build could proceed with no database, which is the thing the gate exists to
 * prevent.
 *
 * Every case runs the real script in its own directory, so what it did to
 * `prisma/schema.prisma` is checked rather than assumed.
 */

const SCRIPT = resolve(import.meta.dirname, "../../scripts/use-provider.mjs");

function schemaFor(provider: "sqlite" | "postgresql"): string {
  return [
    "generator client {",
    '  provider = "prisma-client"',
    "}",
    "",
    "datasource db {",
    `  provider = "${provider}"`,
    "}",
    "",
  ].join("\n");
}

/** A working directory holding just the schema the script edits. */
function checkout(provider: "sqlite" | "postgresql" = "sqlite") {
  const dir = mkdtempSync(join(tmpdir(), "use-provider-"));
  mkdirSync(join(dir, "prisma"));
  writeFileSync(join(dir, "prisma/schema.prisma"), schemaFor(provider));
  return {
    dir,
    provider: () => /provider\s*=\s*"(sqlite|postgresql)"\s*\n\}/.exec(readFileSync(join(dir, "prisma/schema.prisma"), "utf8"))?.[1],
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Nothing inherited but PATH: a stray DATABASE_URL in the test runner's own environment would invalidate every case. */
function run(env: Record<string, string>, cwd: string) {
  return new Promise<{ status: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT, "auto"], {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      cwd,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

describe("resolving the datasource provider for a build", () => {
  test("a preview with no DATABASE_URL continues, leaving the committed provider untouched", async () => {
    const tree = checkout("sqlite");
    try {
      const result = await run({ VERCEL: "1", VERCEL_ENV: "preview" }, tree.dir);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Preview build with no DATABASE_URL/);
      assert.match(result.output, /no database, so pages that read data will fail at runtime/);
      assert.equal(tree.provider(), "sqlite", "the committed provider was rewritten");
    } finally {
      tree.remove();
    }
  });

  test("a production build with no DATABASE_URL still fails, and changes nothing", async () => {
    const tree = checkout("sqlite");
    try {
      const result = await run({ VERCEL: "1", VERCEL_ENV: "production" }, tree.dir);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /DATABASE_URL is not set/);
      assert.doesNotMatch(result.output, /Preview build/);
      assert.equal(tree.provider(), "sqlite");
    } finally {
      tree.remove();
    }
  });

  test("outside Vercel, no DATABASE_URL still fails — the skip is not a general one", async () => {
    for (const env of [{}, { VERCEL_ENV: "development" }, { VERCEL_ENV: "Preview" }, { VERCEL: "1" }]) {
      const tree = checkout("sqlite");
      try {
        const result = await run(env as Record<string, string>, tree.dir);
        assert.equal(result.status, 1, `${JSON.stringify(env)} did not fail: ${result.output}`);
      } finally {
        tree.remove();
      }
    }
  });

  test("a build that is given a database still resolves the provider from it, preview included", async () => {
    const cases = [
      { env: { VERCEL_ENV: "production", DATABASE_URL: "postgresql://u:p@host/db" }, expected: "postgresql" },
      { env: { VERCEL_ENV: "preview", DATABASE_URL: "postgres://u:p@host/db" }, expected: "postgresql" },
      { env: { VERCEL_ENV: "production", DATABASE_URL: "file:./dev.db" }, expected: "sqlite" },
    ];
    for (const { env, expected } of cases) {
      const tree = checkout(expected === "postgresql" ? "sqlite" : "postgresql");
      try {
        const result = await run(env, tree.dir);
        assert.equal(result.status, 0, result.output);
        assert.equal(tree.provider(), expected, `${env.DATABASE_URL} resolved to ${tree.provider()}`);
      } finally {
        tree.remove();
      }
    }
  });
});
