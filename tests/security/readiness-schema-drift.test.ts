import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { db } from "../helpers/fixtures";

/**
 * Readiness has to notice when the code is ahead of the database.
 *
 * This is the regression guard for a production incident: a schema change
 * deployed while its migration was unapplied. The process was alive, `SELECT 1`
 * answered, the `Workspace` table existed — and two pages threw on every
 * request because they selected a column that did not exist yet. Both of the
 * checks readiness performed were structurally incapable of seeing it, so it
 * reported ready throughout.
 *
 * The drift is simulated by removing rows from `_prisma_migrations` rather than
 * by dropping columns: it is the same signal the endpoint reads, and it leaves
 * the database intact for the rest of the suite.
 */

const ROOT = resolve(import.meta.dirname, "../..");

type Removed = { migration_name: string; started_at: Date; finished_at: Date | null;
                 applied_steps_count: number; checksum: string; logs: string | null;
                 rolled_back_at: Date | null; id: string };

let removed: Removed[] = [];

/** Hides the most recent `count` migrations, as an unapplied deploy would. */
async function hideMigrations(count: number) {
  const rows = await db.$queryRawUnsafe<Removed[]>(
    `SELECT * FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT ${count}`,
  );
  removed = rows;
  for (const row of rows) {
    await db.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE id = '${row.id}'`);
  }
  return rows.map((r) => r.migration_name);
}

async function restoreMigrations() {
  for (const r of removed) {
    await db.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ('${r.id}', '${r.checksum}', ${r.finished_at ? `'${new Date(r.finished_at).toISOString()}'` : "NULL"},
               '${r.migration_name}', NULL, NULL, '${new Date(r.started_at).toISOString()}', ${r.applied_steps_count})`,
    );
  }
  removed = [];
}

async function callReady() {
  const { GET } = await import("../../src/app/api/ready/route");
  const response = await GET();
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("readiness notices a database behind the code", () => {
  beforeEach(async () => { await restoreMigrations(); });
  after(async () => { await restoreMigrations(); await db.$disconnect(); });

  test("every migration applied: ready", async () => {
    const { status, body } = await callReady();
    assert.equal(status, 200, `body was ${JSON.stringify(body)}`);
    assert.equal(body.ready, true);
    assert.equal(body.reason, undefined, "a healthy response carried a reason");
  });

  test("one migration missing: 503, schema_behind, pending 1", async () => {
    await hideMigrations(1);
    const { status, body } = await callReady();
    assert.equal(status, 503);
    assert.equal(body.ready, false);
    assert.equal(body.reason, "schema_behind");
    assert.equal(body.pending, 1);
  });

  test("several missing: the count is the number actually missing", async () => {
    const hidden = await hideMigrations(2);
    const { status, body } = await callReady();
    assert.equal(status, 503);
    assert.equal(body.reason, "schema_behind");
    assert.equal(body.pending, hidden.length);
  });

  test("the public body names no migration, table or connection detail", async () => {
    // An unauthenticated probe. It may say that the schema is behind and by how
    // many; it may not describe the schema, the migrations or the database.
    const hidden = await hideMigrations(1);
    const { body } = await callReady();
    const serialised = JSON.stringify(body);

    assert.deepEqual(
      Object.keys(body).sort(),
      ["pending", "ready", "reason"],
      `unexpected keys in the public body: ${serialised}`,
    );
    for (const name of hidden) {
      assert.ok(!serialised.includes(name), `a migration name leaked: ${serialised}`);
    }
    for (const needle of ["postgres", "prisma", "password", "sslmode", "@", "Workspace", "ImportRow"]) {
      assert.ok(
        !serialised.toLowerCase().includes(needle.toLowerCase()),
        `"${needle}" leaked into the public readiness body: ${serialised}`,
      );
    }
  });

  test("a failed migration-state query fails closed rather than open", async () => {
    const { schemaState } = await import("../../src/lib/db/schema-state");
    const { rootDb } = await import("../../src/lib/db");

    const original = rootDb.$queryRaw;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rootDb as any).$queryRaw = async () => { throw new Error("connection reset"); };
    try {
      const state = await schemaState();
      assert.equal(state.status, "unknown", "a broken check reported a definite answer");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rootDb as any).$queryRaw = original;
    }
  });

  test("a half-applied migration does not count as applied", async () => {
    // A migration that failed partway leaves finished_at null. Treating that as
    // done is how a half-migrated database reports healthy.
    const rows = await db.$queryRawUnsafe<{ id: string; migration_name: string }[]>(
      `SELECT id, migration_name FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 1`,
    );
    const target = rows[0]!;
    await db.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET finished_at = NULL WHERE id = '${target.id}'`);
    try {
      const { status, body } = await callReady();
      assert.equal(status, 503, "an unfinished migration reported ready");
      assert.equal(body.reason, "schema_behind");
    } finally {
      await db.$executeRawUnsafe(
        `UPDATE "_prisma_migrations" SET finished_at = CURRENT_TIMESTAMP WHERE id = '${target.id}'`,
      );
    }
  });

  test("the manifest matches the migrations on disk", async () => {
    // The one failure mode of committing generated output: a migration is added
    // and the manifest is not regenerated, so readiness stops checking it.
    const { execFileSync } = await import("node:child_process");
    execFileSync("node", ["scripts/migration-manifest.mjs", "--check"], { cwd: ROOT });
  });

  test("readiness actually reads the manifest", async () => {
    // Guards the shape of the fix rather than only its behaviour: the old route
    // consulted nothing but a table-exists query, and would pass every
    // behavioural test above if the manifest comparison were removed and the
    // migrations happened to be applied.
    const source = readFileSync(resolve(ROOT, "src/app/api/ready/route.ts"), "utf8");
    assert.match(source, /schemaState\(\)/, "readiness no longer checks migration state");
    assert.match(source, /schema_behind/, "readiness no longer reports schema drift");
  });
});
