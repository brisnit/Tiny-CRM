-- Records which published terms version an account accepted, and when.
--
-- SQLite history: local development and the fast suite. The PostgreSQL copy of
-- this migration lives in prisma/migrations-postgres/ and uses TIMESTAMP(3).
--
-- Both columns are nullable and additive only, which is what makes this safe to
-- apply to production *before* the code that writes them is deployed: the build
-- currently running selects neither column, so it is unaffected.
--
-- There is no backfill. Inventing an acceptance timestamp for an account that
-- never saw the checkbox would put a false record in the one place a dispute
-- would look. A NULL honestly means "no acceptance was recorded".
ALTER TABLE "User" ADD COLUMN "termsAcceptedVersion" TEXT;
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" DATETIME;
