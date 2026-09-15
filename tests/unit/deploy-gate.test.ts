import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  QUERIES, RLS_EXCEPTIONS, databaseFingerprint, decide, evaluate, shippedMigrations,
} from "../../scripts/deploy-gate.mjs";
import { POSTGRES_MIGRATIONS } from "../../src/lib/db/migration-manifest";

/**
 * The deployment gate's rules, without a database.
 *
 * scripts/deploy-gate-proof.mjs proves the same rules against real PostgreSQL,
 * and the real-Vercel proof in docs/DEPLOYMENT.md proves the platform honours
 * the exit code. This suite pins the verdict logic and — as important — the
 * properties that keep the gate trustworthy: that it reads nothing it could be
 * tricked by, writes nothing, and has no way to be told to look away.
 *
 * Every block is paired with the matching pass, so a gate that blocks
 * everything cannot satisfy it.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = readFileSync(resolve(ROOT, "scripts/deploy-gate.mjs"), "utf8");
const shipped = ["00000000000000_init", "20260910224119_import_batches", "20260911180102_workspace_invitations"];
const healthy = {
  shipped,
  applied: shipped,
  nonDeferrableForeignKeys: [] as string[],
  rlsNotForced: [] as string[],
  workspaceTablesWithoutRls: ["IdempotencyKey"],
};

describe("the deployment gate's verdict", () => {
  test("a database one migration behind the commit is blocked, and the migration is named", () => {
    const verdict = evaluate({ ...healthy, applied: shipped.slice(0, -1) });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.problems, [
      { kind: "missing_migrations", items: ["20260911180102_workspace_invitations"] },
    ]);
    assert.equal(evaluate(healthy).ok, true, "a fully migrated database was blocked");
  });

  test("a database ahead of the commit passes — a rollback must never be blocked", () => {
    assert.equal(evaluate({ ...healthy, applied: [...shipped, "20990101000000_future"] }).ok, true);
  });

  test("a gap in the middle of the history is blocked, not only a missing tail", () => {
    const verdict = evaluate({ ...healthy, applied: [shipped[0]!, shipped[2]!] });
    assert.deepEqual(verdict.problems, [{ kind: "missing_migrations", items: [shipped[1]] }]);
  });

  test("a build that ships no migrations is blocked rather than trivially passing", () => {
    const verdict = evaluate({ ...healthy, shipped: [], applied: [] });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.problems[0]!.kind, "no_shipped_migrations");
  });

  test("a non-deferrable foreign key is blocked and named; none is fine", () => {
    const verdict = evaluate({ ...healthy, nonDeferrableForeignKeys: ["ImportRow.ImportRow_batchId_fkey"] });
    assert.deepEqual(verdict.problems, [
      { kind: "non_deferrable_foreign_keys", items: ["ImportRow.ImportRow_batchId_fkey"] },
    ]);
    assert.equal(evaluate({ ...healthy, nonDeferrableForeignKeys: [] }).ok, true);
  });

  test("row-level security enabled without FORCE is blocked and named", () => {
    const verdict = evaluate({ ...healthy, rlsNotForced: ["Company"] });
    assert.deepEqual(verdict.problems, [{ kind: "rls_not_forced", items: ["Company"] }]);
  });

  test("a workspace table without row-level security is blocked, unless it is a documented exception", () => {
    const verdict = evaluate({ ...healthy, workspaceTablesWithoutRls: ["Company", "IdempotencyKey"] });
    assert.deepEqual(verdict.problems, [{ kind: "workspace_tables_without_rls", items: ["Company"] }]);
    assert.equal(
      evaluate({ ...healthy, workspaceTablesWithoutRls: ["IdempotencyKey"] }).ok,
      true,
      "the documented exception was blocked",
    );
  });

  test("every problem is reported together, not just the first", () => {
    const verdict = evaluate({
      ...healthy,
      applied: shipped.slice(0, -1),
      nonDeferrableForeignKeys: ["ImportBatch.ImportBatch_actorId_fkey"],
      rlsNotForced: ["Note"],
      workspaceTablesWithoutRls: ["Task"],
    });
    assert.deepEqual(
      verdict.problems.map((p) => p.kind),
      ["missing_migrations", "non_deferrable_foreign_keys", "rls_not_forced", "workspace_tables_without_rls"],
    );
  });
});

describe("which builds are gated: production always, a preview without a database never", () => {
  const POSTGRES = "postgresql://tinycrm_app:pw@ep-example.neon.tech/neondb?sslmode=require";

  test("production with a current database is checked and passes; one migration behind is blocked", () => {
    // The real-database versions of both run in scripts/deploy-gate-proof.mjs.
    assert.deepEqual(decide({ VERCEL_ENV: "production", DATABASE_URL: POSTGRES }), { action: "check", url: POSTGRES });
    assert.equal(evaluate(healthy).ok, true);
    assert.equal(evaluate({ ...healthy, applied: shipped.slice(0, -1) }).ok, false);
  });

  test("production with no database, or a non-PostgreSQL one, is blocked — never skipped", () => {
    for (const DATABASE_URL of [undefined, "", "file:./dev.db", "mysql://x@y/z"]) {
      assert.deepEqual(decide({ VERCEL_ENV: "production", DATABASE_URL }), { action: "block" },
        `production with DATABASE_URL=${String(DATABASE_URL)} was not blocked`);
    }
  });

  test("a preview with no DATABASE_URL at all is skipped", () => {
    assert.deepEqual(decide({ VERCEL_ENV: "preview", DATABASE_URL: undefined }), { action: "skip" });
    assert.deepEqual(decide({ VERCEL_ENV: "preview", DATABASE_URL: "" }), { action: "skip" });
  });

  test("the skip is narrow: only exactly \"preview\", and only with no database at all", () => {
    // A preview given a database is checked, not skipped.
    assert.deepEqual(decide({ VERCEL_ENV: "preview", DATABASE_URL: POSTGRES }), { action: "check", url: POSTGRES });
    // A preview given something that is not PostgreSQL is not "no database"; it is blocked.
    assert.deepEqual(decide({ VERCEL_ENV: "preview", DATABASE_URL: "file:./dev.db" }), { action: "block" });
    // Nothing that is not literally a preview reaches the skip.
    for (const VERCEL_ENV of [undefined, "", "development", "Preview", " preview", "preview ", "production"]) {
      assert.deepEqual(decide({ VERCEL_ENV, DATABASE_URL: undefined }), { action: "block" },
        `VERCEL_ENV=${JSON.stringify(VERCEL_ENV)} with no database was not blocked`);
    }
  });
});

/**
 * The same rules, through the real script, with production credentials planted
 * everywhere a careless fallback might find them.
 *
 * The "production database" is a local TCP listener that counts connections,
 * so "never used" is measured rather than inferred from the output. The control
 * proves the listener would notice: a build that is actually given it connects.
 */
describe("a preview never reaches production credentials", () => {
  const GATE = resolve(ROOT, "scripts/deploy-gate.mjs");

  async function decoyDatabase() {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    return {
      port,
      url: `postgresql://tinycrm_app:production-password@127.0.0.1:${port}/neondb`,
      connections: () => connections,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }

  /** Every other place a production connection might be picked up from. */
  function plantedCredentials(decoy: { url: string; port: number }): Record<string, string> {
    return {
      DIRECT_URL: decoy.url,
      POSTGRES_URL: decoy.url,
      POSTGRES_PRISMA_URL: decoy.url,
      POSTGRES_URL_NON_POOLING: decoy.url,
      DATABASE_URL_UNPOOLED: decoy.url,
      PRODUCTION_DATABASE_URL: decoy.url,
      NEON_DATABASE_URL: decoy.url,
      // node-postgres defaults to these when it is given no connection string.
      PGHOST: "127.0.0.1",
      PGPORT: String(decoy.port),
      PGUSER: "tinycrm_app",
      PGPASSWORD: "production-password",
      PGDATABASE: "neondb",
    };
  }

  /** Async, never spawnSync: the listener must be free to accept while the gate runs. */
  function runGate(env: Record<string, string>, cwd: string) {
    return new Promise<{ status: number | null; output: string }>((done) => {
      // Nothing inherited but PATH, so no stray variable can influence the result.
      const childEnv = { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv;
      const child = spawn(process.execPath, [GATE], { env: childEnv, cwd });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (status) => done({ status, output }));
    });
  }

  /** A working directory holding .env files that point at the decoy, in case anything ever loads them. */
  function directoryWithEnvFiles(url: string) {
    const dir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
    for (const name of [".env", ".env.local", ".env.production", ".env.preview"]) {
      writeFileSync(join(dir, name), `DATABASE_URL=${url}\n`);
    }
    return dir;
  }

  test("a preview with no DATABASE_URL skips successfully and never connects to the production database", async () => {
    const decoy = await decoyDatabase();
    const cwd = directoryWithEnvFiles(decoy.url);
    try {
      const run = await runGate({ VERCEL: "1", VERCEL_ENV: "preview", ...plantedCredentials(decoy) }, cwd);
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /DEPLOYMENT GATE: SKIPPED — preview build has no isolated Preview database/);
      assert.doesNotMatch(run.output, /DEPLOYMENT GATE: (PASSED|BLOCKED)/);
      assert.doesNotMatch(run.output, /database fingerprint/, "a skipped preview identified a database");
      assert.doesNotMatch(run.output, /production-password/);
      assert.equal(decoy.connections(), 0, "the preview build connected to the production database");
    } finally {
      await decoy.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a production build with no DATABASE_URL is blocked, and does not fall back to production credentials either", async () => {
    const decoy = await decoyDatabase();
    const cwd = directoryWithEnvFiles(decoy.url);
    try {
      const run = await runGate({ VERCEL: "1", VERCEL_ENV: "production", ...plantedCredentials(decoy) }, cwd);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /DEPLOYMENT GATE: BLOCKED/);
      assert.match(run.output, /no PostgreSQL DATABASE_URL/);
      assert.doesNotMatch(run.output, /SKIPPED/);
      assert.equal(decoy.connections(), 0, "the gate found a database somewhere other than DATABASE_URL");
    } finally {
      await decoy.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("control: the decoy does detect a connection — a build actually given it connects, and is blocked", async () => {
    const decoy = await decoyDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "deploy-gate-"));
    try {
      const run = await runGate({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: decoy.url }, cwd);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /could not read the database/);
      assert.ok(decoy.connections() >= 1, "the decoy saw no connection, so the tests above would prove nothing");
      assert.doesNotMatch(run.output, /production-password/, "the connection string reached the log");
    } finally {
      await decoy.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("what the gate checks against", () => {
  test("the migrations it expects are exactly the ones the readiness manifest expects", () => {
    // Two lists of "what this build needs" would drift. Both derive from the
    // same directory; this proves they still agree.
    assert.deepEqual(shippedMigrations(ROOT), [...POSTGRES_MIGRATIONS]);
    assert.ok(shippedMigrations(ROOT).length >= 3, "the migration directory was not found");
  });

  test("the exception allowlist is exactly docs/RLS.md's documented exceptions that carry a workspaceId", () => {
    const doc = readFileSync(resolve(ROOT, "docs/RLS.md"), "utf8");
    const section = doc.split("## Which tables intentionally do not")[1]?.split(/\n## /)[0] ?? "";
    const documented = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]!);
    // Parser sanity: an empty or misread section would make the comparison vacuous.
    assert.ok(documented.includes("User") && documented.includes("_prisma_migrations"),
      `could not read the exceptions table from docs/RLS.md (got: ${documented.join(", ")})`);

    const schema = readFileSync(resolve(ROOT, "prisma/schema.prisma"), "utf8");
    const withWorkspaceId = new Set(
      [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
        .filter((m) => /^\s*workspaceId\s+String/m.test(m[2]!))
        .map((m) => m[1]!),
    );

    const expected = documented.filter((table) => withWorkspaceId.has(table)).sort();
    assert.deepEqual([...RLS_EXCEPTIONS].sort(), expected,
      "the gate's RLS exceptions and docs/RLS.md disagree — document the exception, or remove it");
  });
});

describe("what keeps the gate trustworthy", () => {
  test("it finds workspaceId columns through pg_attribute, which a low-privilege role cannot hide", () => {
    assert.match(QUERIES.workspaceTablesWithoutRls, /pg_attribute/);
    assert.doesNotMatch(QUERIES.workspaceTablesWithoutRls, /information_schema/,
      "information_schema.columns hides columns the role has no privilege on, which would pass a database with no RLS");
  });

  test("it cannot write: reads run in a read-only transaction, and no query mutates", () => {
    assert.match(SOURCE, /BEGIN READ ONLY/);
    for (const [name, sql] of Object.entries(QUERIES)) {
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i, `${name} mutates`);
    }
    assert.doesNotMatch(SOURCE, /child_process|migrate deploy\s*[`'"]\s*\)/,
      "the gate must never run a migration itself");
  });

  test("there is no override: it reads no environment variable except the database and Vercel's own", () => {
    const read = new Set([...SOURCE.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!));
    const bracketed = [...SOURCE.matchAll(/process\.env\[/g)];
    assert.equal(bracketed.length, 0, "dynamic environment access could hide an override");
    assert.deepEqual([...read].sort(), ["DATABASE_URL", "VERCEL", "VERCEL_ENV"],
      `the gate reads an environment variable that could become a bypass: ${[...read].join(", ")}`);
  });

  test("every Vercel build, and every `vercel build` for --prebuilt, runs the gate before anything else", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8")) as { buildCommand?: string };
    assert.ok(
      config.buildCommand?.startsWith("node scripts/deploy-gate.mjs && "),
      `vercel.json buildCommand does not start with the gate: ${config.buildCommand}`,
    );
  });

  test("the fingerprint it logs identifies a database without revealing its credentials", () => {
    const url = "postgresql://tinycrm_app:s3cret-pass@ep-example-123.us-west-2.aws.neon.tech/neondb?sslmode=require";
    const fingerprint = databaseFingerprint(url);
    assert.match(fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(fingerprint, databaseFingerprint(url.replace("s3cret-pass", "different")),
      "the fingerprint depends on the password, so it could leak something about it");
    assert.notEqual(fingerprint, databaseFingerprint(url.replace("neondb", "otherdb")),
      "two different databases share a fingerprint, so the log could not tell them apart");
  });
});
