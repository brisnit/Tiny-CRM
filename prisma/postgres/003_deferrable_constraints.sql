-- Make every foreign key DEFERRABLE, so a logical restore is possible at all.
--
-- Apply after `prisma migrate deploy`. Not part of the portable migration
-- history: SQLite has no equivalent, and Prisma cannot express this.
--
-- ---------------------------------------------------------------------------
-- The problem this solves
-- ---------------------------------------------------------------------------
--
-- The schema contains a **circular foreign key**:
--
--   Company.primaryContactId  ->  Contact.id
--   Contact.companyId         ->  Company.id
--
-- It is the right data model — an account has a main person, a person works at
-- an account — and it makes a row-ordered restore impossible. Whichever table is
-- loaded first references rows in the other that do not exist yet. There is no
-- ordering that works, because the dependency is a cycle rather than a tree.
--
-- This was found by running scripts/backup-test.mjs, not by reading the schema.
-- The restore failed at step 4 with:
--
--   insert or update on table "Company" violates foreign key constraint
--   "Company_primaryContactId_fkey"
--
-- which is precisely the failure a team would otherwise discover during an
-- incident, holding a backup they cannot load.
--
-- ---------------------------------------------------------------------------
-- The fix
-- ---------------------------------------------------------------------------
--
-- `DEFERRABLE INITIALLY IMMEDIATE` changes nothing about normal operation:
-- constraints are still checked per statement, and an application bug that
-- writes a dangling reference still fails immediately. What it adds is the
-- *option*, inside an explicit transaction, to run:
--
--   SET CONSTRAINTS ALL DEFERRED;
--
-- which postpones checking to COMMIT. A restore can then load tables in any
-- order and have the whole graph verified once, at the end — all or nothing.
--
-- The alternative, `ALTER TABLE … DISABLE TRIGGER ALL`, requires superuser and
-- skips the checks entirely rather than deferring them. Deferring is strictly
-- better: the constraints are still enforced, just later.
--
-- Cost: a deferred check holds its row locks until COMMIT, so a long
-- transaction that defers everything holds more locks than one that does not.
-- That is a restore-shaped workload, which is exactly when it is acceptable.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT
      con.conname                       AS name,
      con.conrelid::regclass::text      AS tbl
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f'
      AND rel.relnamespace = 'public'::regnamespace
      AND NOT con.condeferrable
  LOOP
    EXECUTE format(
      'ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      fk.tbl, fk.name
    );
  END LOOP;
END
$$;

-- Verification: every foreign key in the public schema should now be deferrable
-- and still immediate by default.
--
--   SELECT count(*) FILTER (WHERE condeferrable)  AS deferrable,
--          count(*) FILTER (WHERE condeferred)    AS deferred_by_default,
--          count(*)                               AS total
--   FROM pg_constraint con
--   JOIN pg_class rel ON rel.oid = con.conrelid
--   WHERE con.contype = 'f' AND rel.relnamespace = 'public'::regnamespace;
--
-- Expected: deferrable = total, deferred_by_default = 0.
