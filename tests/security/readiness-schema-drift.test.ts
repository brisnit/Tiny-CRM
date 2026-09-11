import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";


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
 * The first version of this suite simulated the drift by deleting rows from
 * `_prisma_migrations` and putting them back. That is Prisma's own ledger in a
 * database the whole suite shares, so a restore that ever failed would hand a
 * broken migration history to every test that ran afterwards — and CI failed
 * on PostgreSQL 17 in one run and PostgreSQL 18 in another, which is what that
 * looks like from the outside. The comparison is now a pure function and the
 * route is exercised with the query stubbed. Nothing here touches the database
 * at all, which is also why it runs identically on either engine.
 */

const ROOT = resolve(import.meta.dirname, "../..");

async function callReadyWithApplied(applied: string[] | Error) {
  const { rootDb } = await import("../../src/lib/db");
  const { GET } = await import("../../src/app/api/ready/route");
  const original = rootDb.$queryRaw;

  // Only the migration-ledger read is answered from the stub. The route also
  // runs a table-exists query first, and `db` is a proxy over this very object,
  // so a stub that answered everything would fail that check instead and the
  // suite would pass or fail for the wrong reason — which is exactly what it
  // did the first time this was written.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rootDb as any).$queryRaw = function (this: unknown, ...args: unknown[]) {
    const [template] = args as [TemplateStringsArray | unknown];
    const sql = Array.isArray(template) ? (template as unknown as string[]).join(" ") : "";
    if (!sql.includes("_prisma_migrations")) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any).apply(rootDb, args);
    }
    if (applied instanceof Error) return Promise.reject(applied);
    return Promise.resolve(applied.map((migration_name) => ({ migration_name })));
  };
  try {
    const response = await GET();
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rootDb as any).$queryRaw = original;
  }
}

describe("readiness notices a database behind the code", () => {
  test("every migration applied: ready", async () => {
    const { expectedMigrations } = await import("../../src/lib/db/schema-state");
    const { status, body } = await callReadyWithApplied([...expectedMigrations()]);
    assert.equal(status, 200, `body was ${JSON.stringify(body)}`);
    assert.equal(body.ready, true);
    assert.equal(body.reason, undefined, "a healthy response carried a reason");
  });

  test("one migration missing: 503, schema_behind, pending 1", async () => {
    const { expectedMigrations } = await import("../../src/lib/db/schema-state");
    const applied = [...expectedMigrations()].slice(0, -1);
    const { status, body } = await callReadyWithApplied(applied);
    assert.equal(status, 503);
    assert.equal(body.ready, false);
    assert.equal(body.reason, "schema_behind");
    assert.equal(body.pending, 1);
  });

  test("several missing: the count is the number actually missing", async () => {
    const { compareMigrations } = await import("../../src/lib/db/schema-state");
    const expected = ["a", "b", "c", "d", "e"];
    for (const missing of [1, 2, 3, 5]) {
      const state = compareMigrations(expected, expected.slice(0, expected.length - missing));
      assert.equal(state.status, "behind");
      if (state.status === "behind") assert.equal(state.pending, missing, `missing ${missing}`);
    }
  });

  test("a gap in the middle counts, not just a missing tail", async () => {
    // The shape a hand-applied history goes wrong in: one migration applied,
    // an earlier one skipped. A count-based check would call this current.
    const { compareMigrations } = await import("../../src/lib/db/schema-state");
    const state = compareMigrations(["a", "b", "c"], ["a", "c", "zz_unrelated"]);
    assert.equal(state.status, "behind");
    if (state.status === "behind") {
      assert.equal(state.pending, 1);
      assert.deepEqual(state.pendingNames, ["b"]);
    }
  });

  test("a database ahead of the code is still ready", async () => {
    // Mid-rollout, or after a rollback. Old code runs fine against a newer
    // schema, and refusing traffic there would turn a deploy into an outage.
    const { compareMigrations } = await import("../../src/lib/db/schema-state");
    assert.equal(compareMigrations(["a", "b"], ["a", "b", "c"]).status, "current");
  });

  test("the public body names no migration, table or connection detail", async () => {
    const { expectedMigrations } = await import("../../src/lib/db/schema-state");
    const expected = [...expectedMigrations()];
    const { body } = await callReadyWithApplied(expected.slice(0, -1));
    const serialised = JSON.stringify(body);

    assert.deepEqual(
      Object.keys(body).sort(),
      ["pending", "ready", "reason"],
      `unexpected keys in the public body: ${serialised}`,
    );
    assert.ok(
      !serialised.includes(expected[expected.length - 1]!),
      `a migration name leaked: ${serialised}`,
    );
    for (const needle of ["postgres", "prisma", "password", "sslmode", "@", "Workspace", "ImportRow"]) {
      assert.ok(
        !serialised.toLowerCase().includes(needle.toLowerCase()),
        `"${needle}" leaked into the public readiness body: ${serialised}`,
      );
    }
  });

  test("a failed migration-state query fails closed rather than open", async () => {
    const { status, body } = await callReadyWithApplied(new Error("connection reset"));
    assert.equal(status, 503, "a broken check reported ready");
    assert.equal(body.ready, false);
    assert.equal(body.reason, "schema_unknown");
  });

  test("an empty manifest is unknown, not current", async () => {
    // A build that somehow shipped without a manifest knows nothing about the
    // schema, and knowing nothing must not read as ready.
    const { compareMigrations } = await import("../../src/lib/db/schema-state");
    const state = compareMigrations([], ["a"]);
    assert.equal(state.status, "unknown");
  });

  test("the query only counts finished, un-rolled-back migrations", async () => {
    // A migration that failed partway leaves finished_at null; one that was
    // rolled back leaves rolled_back_at set. Counting either as applied is how
    // a half-migrated database reports healthy.
    const source = readFileSync(resolve(ROOT, "src/lib/db/schema-state.ts"), "utf8");
    assert.match(source, /finished_at IS NOT NULL/, "unfinished migrations would count as applied");
    assert.match(source, /rolled_back_at IS NULL/, "rolled-back migrations would count as applied");
  });

  test("the manifest matches the migrations on disk", async () => {
    // The one failure mode of committing generated output: a migration is added
    // and the manifest is not regenerated, so readiness stops checking it.
    const { execFileSync } = await import("node:child_process");
    execFileSync("node", ["scripts/migration-manifest.mjs", "--check"], { cwd: ROOT });
  });

  test("readiness actually consults the manifest", async () => {
    // Guards the shape of the fix, not only its behaviour: the old route
    // consulted nothing but a table-exists query.
    const source = readFileSync(resolve(ROOT, "src/app/api/ready/route.ts"), "utf8");
    assert.match(source, /schemaState\(\)/, "readiness no longer checks migration state");
    assert.match(source, /schema_behind/, "readiness no longer reports schema drift");
  });
});
