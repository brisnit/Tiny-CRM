-- PostgreSQL-only search indexes.
--
-- Apply AFTER `prisma migrate deploy` on PostgreSQL. These are not part of the
-- portable migration history because SQLite has no equivalent and Prisma
-- Migrate would then refuse to run one of the two engines.
--
-- Why they are needed: universal search and every list filter use a
-- case-insensitive substring match (see `contains()` in src/lib/db.ts), which
-- compiles to ILIKE '%term%' on PostgreSQL. A btree index cannot serve a
-- leading-wildcard match, so without these the search degrades to a sequential
-- scan once a workspace passes a few thousand rows.
--
-- CONCURRENTLY keeps the table writable while the index builds; it cannot run
-- inside a transaction, so apply this file with `psql -f`, not through a
-- migration runner that wraps statements in a transaction.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_fullName_trgm"
  ON "Contact" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_email_trgm"
  ON "Contact" USING gin ("email" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_jobTitle_trgm"
  ON "Contact" USING gin ("jobTitle" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Company_name_trgm"
  ON "Company" USING gin ("name" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Company_domain_trgm"
  ON "Company" USING gin ("domain" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Deal_name_trgm"
  ON "Deal" USING gin ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Project_name_trgm"
  ON "Project" USING gin ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Opportunity_name_trgm"
  ON "Opportunity" USING gin ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_title_trgm"
  ON "Task" USING gin ("title" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_plainText_trgm"
  ON "Note" USING gin ("plainText" gin_trgm_ops);

-- The audit log is append-only and read by (workspace, time) or by entity.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_workspace_createdAt"
  ON "AuditLog" ("workspaceId", "createdAt" DESC);
