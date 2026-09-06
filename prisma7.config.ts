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
const isPostgres = /^postgres(ql)?:\/\//.test(process.env["DATABASE_URL"] ?? "");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: isPostgres ? "prisma/migrations-postgres" : "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
