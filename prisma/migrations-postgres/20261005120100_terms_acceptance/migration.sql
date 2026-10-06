-- Records which published terms version an account accepted, and when.
--
-- PostgreSQL history: every deployed environment. The SQLite copy lives in
-- prisma/migrations/ and uses DATETIME.
--
-- Both columns are nullable and additive only. That is what makes the required
-- deployment order safe: this is applied to production BEFORE the code that
-- writes it is deployed, and the build currently serving traffic selects neither
-- column, so adding them changes nothing for it.
--
-- Applying it first is not optional. scripts/deploy-gate.mjs compares the
-- migrations this commit ships in prisma/migrations-postgres against the rows in
-- public."_prisma_migrations", and fails the build if one is missing.
--
-- There is no backfill. Inventing an acceptance timestamp for an account that
-- never saw the checkbox would put a false record in the one place a dispute
-- would look. A NULL honestly means "no acceptance was recorded".
ALTER TABLE "User" ADD COLUMN "termsAcceptedVersion" TEXT;
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
