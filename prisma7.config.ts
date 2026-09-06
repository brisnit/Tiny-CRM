import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma's migration history is provider-locked.
 *
 * `migration_lock.toml` records the provider a history was authored against,
 * and the SQL inside it is written in that engine's dialect. A SQLite history
 * therefore cannot be applied to PostgreSQL at all — `migrate deploy` refuses
 * with P3019. The previous hardening pass described switching engines as "a
 * one-word change"; it is not, and this file is where that is handled.
 *
 * Two histories are kept side by side, both generated from the same
 * provider-agnostic schema:
 *
 *   prisma/migrations/           SQLite      — local development and the fast suite
 *   prisma/migrations-postgres/  PostgreSQL  — every deployed environment
 *
 * The path follows the datasource, which `scripts/use-provider.mjs` switches.
 * Regenerate the PostgreSQL history after a schema change with:
 *
 *   node scripts/sync-postgres-migration.mjs
 */
/**
 * DIRECT_URL vs DATABASE_URL.
 *
 * A serverless deployment points DATABASE_URL at a *pooled* endpoint (PgBouncer
 * in transaction mode, or a provider's equivalent). Two things do not work
 * through transaction pooling: DDL, and the advisory lock Prisma takes to
 * serialise a migration. So the CLI needs an unpooled connection.
 *
 * Prisma 7's config datasource exposes only `url` and `shadowDatabaseUrl` —
 * there is no `directUrl` property as there was in the Prisma 5/6 schema block.
 * This file is read exclusively by the CLI (migrate, db, introspect), never by
 * the running application, so resolving it here gives the correct split:
 *
 *   DIRECT_URL     unpooled, admin/owner role, migrations only.
 *                  Used from an operator's machine. NEVER set in Vercel.
 *   DATABASE_URL   pooled, tinycrm_app role, the running application.
 *                  Read by src/lib/db.ts at runtime.
 *
 * If DIRECT_URL is unset the CLI falls back to DATABASE_URL, which is correct
 * for local development and for a provider with no separate pooler.
 */
const migrationUrl = process.env["DIRECT_URL"] || process.env["DATABASE_URL"];

// Either URL is enough to identify the engine; a migration run may set only one.
const isPostgres = /^postgres(ql)?:\/\//.test(migrationUrl ?? "");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: isPostgres ? "prisma/migrations-postgres" : "prisma/migrations",
  },
  datasource: {
    url: migrationUrl,
    ...(process.env["SHADOW_DATABASE_URL"]
      ? { shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"] }
      : {}),
  },
});
