import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { DEV_AUTH_SECRET } from "../../src/lib/env";

/**
 * The production startup gate.
 *
 * `assertProductionEnv()` reads process-level configuration at import time, so
 * it can only be tested honestly in a fresh process. Each case here launches the
 * real `npm run check:config` command — the same one a deploy pipeline runs and
 * the same code `instrumentation.ts` calls at boot — with a deliberately unsafe
 * environment, and asserts that the process refuses to start.
 *
 * These are slow (a process launch each) and worth it: this gate is the only
 * thing standing between a development convenience and a production incident.
 */

const SAFE: Record<string, string> = {
  NODE_ENV: "production",
  AUTH_SECRET: "an-actual-production-secret-value-of-sufficient-length",
  DATABASE_URL: "postgresql://user:pw@db.internal:5432/tinycrm",
  APP_URL: "https://app.tinycrm.test",
};

function check(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...SAFE,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const result = spawnSync("npx", ["tsx", "scripts/check-config.ts"], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("production configuration gate", () => {
  test("a correctly configured production environment starts", () => {
    const { status, output } = check({});
    assert.equal(status, 0, `a safe configuration was refused:\n${output}`);
  });

  test("refuses to start without AUTH_SECRET", () => {
    const { status, output } = check({ AUTH_SECRET: undefined });
    assert.equal(status, 1, "production started with no session secret");
    assert.match(output, /AUTH_SECRET/);
  });

  test("refuses the published development secret", () => {
    // The development default is in the repository. If it reached production,
    // anyone could mint a valid session cookie for any account.
    const { status, output } = check({
      AUTH_SECRET: DEV_AUTH_SECRET,
    });
    assert.equal(status, 1, "production started with the published dev secret");
    assert.match(output, /development value/i);
  });

  test("refuses a short AUTH_SECRET", () => {
    const { status } = check({ AUTH_SECRET: "too-short" });
    assert.equal(status, 1, "production started with a weak session secret");
  });

  test("refuses demo authentication", () => {
    const { status, output } = check({ ALLOW_DEMO_AUTH: "true" });
    assert.equal(status, 1, "the demo login was reachable in production");
    assert.match(output, /ALLOW_DEMO_AUTH/);
  });

  test("refuses a SQLite database", () => {
    const { status, output } = check({ DATABASE_URL: "file:./dev.db" });
    assert.equal(status, 1, "production started on a local SQLite file");
    assert.match(output, /SQLite|PostgreSQL/i);
  });

  test("refuses a non-HTTPS or localhost APP_URL", () => {
    for (const url of ["http://app.tinycrm.test", "https://localhost:3000", "http://127.0.0.1:3000"]) {
      const { status } = check({ APP_URL: url });
      assert.equal(status, 1, `production accepted APP_URL=${url}`);
    }
  });

  test("refuses to run with demo seeding enabled", () => {
    const { status, output } = check({ SEED_ALLOW_PRODUCTION: "1" });
    assert.equal(status, 1, "demo data could be seeded into production");
    assert.match(output, /SEED_ALLOW_PRODUCTION/);
  });

  test("refuses to run with the test identity hook enabled", () => {
    // This hook lets in-process tests act as any user without a password. In
    // production it would be a complete authentication bypass.
    const { status, output } = check({ TINYCRM_TEST_IDENTITY: "any-user-id" });
    assert.equal(status, 1, "the test identity bypass was reachable in production");
    assert.match(output, /TINYCRM_TEST_IDENTITY/);
  });

  test("reports every problem at once rather than one per deploy", () => {
    const { status, output } = check({
      AUTH_SECRET: undefined,
      DATABASE_URL: "file:./dev.db",
      APP_URL: "http://localhost:3000",
    });
    assert.equal(status, 1);
    assert.match(output, /1\./);
    assert.match(output, /3\./, "problems were reported one at a time");
  });

  test("the gate does not run outside production", () => {
    // Development must stay usable with a SQLite file and no secret set.
    const { status } = check({
      NODE_ENV: "development",
      AUTH_SECRET: undefined,
      DATABASE_URL: "file:./dev.db",
      APP_URL: "http://localhost:3000",
    });
    assert.equal(status, 0, "the production gate fired in development");
  });
});

describe("demo data cannot reach production", () => {
  /**
   * The seed script deletes every row and creates accounts with a published
   * password. It has to refuse a real database *before* it connects, which is
   * why the guard is a side-effecting import rather than a check inside main().
   */
  const seed = (env: Record<string, string | undefined>) => {
    const merged: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) merged[key] = value;
    }
    const result = spawnSync("npx", ["tsx", "prisma/seed/index.ts"], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: merged as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  test("refuses to seed when NODE_ENV is production", () => {
    const { status, output } = seed({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pw@db.internal:5432/tinycrm",
    });
    assert.equal(status, 1, "the seed ran against a production database");
    assert.match(output, /Refusing to seed/);
  });

  test("refuses to seed any non-SQLite database, even without NODE_ENV", () => {
    // A cron that forgets NODE_ENV must not be the only thing standing between
    // a customer's data and a full table wipe.
    const { status, output } = seed({
      DATABASE_URL: "postgresql://user:pw@db.internal:5432/tinycrm",
    });
    assert.equal(status, 1, "the seed ran against PostgreSQL");
    assert.match(output, /Refusing to seed/);
  });

  test("does not echo credentials back when refusing", () => {
    const { output } = seed({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://admin:hunter2@db.internal:5432/tinycrm",
    });
    assert.ok(!output.includes("hunter2"), "the refusal message leaked the database password");
    assert.ok(!output.includes("admin"), "the refusal message leaked the database user");
  });
});
