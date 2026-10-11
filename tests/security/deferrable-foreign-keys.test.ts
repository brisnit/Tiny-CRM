import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { db } from "../../src/lib/db";
import { isPostgres } from "../../src/lib/env";

/**
 * Every foreign key must be deferrable, asserted against the database.
 *
 * The deployment gate already checks this on every production build, and the
 * gate's own decision logic is unit-tested with synthetic input. Neither of
 * those asked the actual database, so when a migration added three
 * non-deferrable foreign keys the first thing to notice was a blocked
 * production deploy.
 *
 * The reason it matters is in prisma/postgres/003_deferrable_constraints.sql:
 * the schema has a circular foreign key (Company.primaryContactId ↔
 * Contact.companyId), so no row ordering restores a logical backup unless
 * constraints can be deferred. A backup you cannot load is not a backup.
 *
 * PostgreSQL only: SQLite has no deferrable constraints and nothing to assert.
 */
const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with deferrable constraints only" };

describe("foreign keys can be deferred, so a logical restore is possible", () => {
  test("not one foreign key in the public schema is non-deferrable", pgOnly, async () => {
    const rows = await db.$queryRaw<{ tbl: string; name: string }[]>`
      SELECT con.conrelid::regclass::text AS tbl, con.conname AS name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE con.contype = 'f'
         AND rel.relnamespace = 'public'::regnamespace
         AND NOT con.condeferrable
       ORDER BY 1, 2
    `;
    assert.deepEqual(
      rows.map((r) => `${r.tbl}.${r.name}`),
      [],
      "these foreign keys cannot be deferred, so a logical restore would fail — " +
        "apply prisma/postgres/003_deferrable_constraints.sql after the migration that added them",
    );
  });

  test("and the tables this release added are covered by that", pgOnly, async () => {
    // Named explicitly, so a future reordering of the apply sequence fails here
    // rather than at a production deploy.
    const rows = await db.$queryRaw<{ name: string; deferrable: boolean }[]>`
      SELECT con.conname AS name, con.condeferrable AS deferrable
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE con.contype = 'f'
         AND rel.relnamespace = 'public'::regnamespace
         AND rel.relname IN ('PlatformAdmin', 'PlanGrant')
       ORDER BY 1
    `;
    assert.equal(rows.length, 3, "the three foreign keys this release adds were not found");
    for (const row of rows) {
      assert.equal(row.deferrable, true, `${row.name} is not deferrable`);
    }
  });
});
