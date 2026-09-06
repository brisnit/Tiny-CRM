import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env, isPostgres, isProduction } from "@/lib/env";

/**
 * Prisma 7 talks to the database through a driver adapter, which is what lets
 * this app run on SQLite locally and PostgreSQL in production from one schema.
 * The adapter is chosen from the shape of DATABASE_URL, so promoting to Postgres
 * is a connection-string change plus the one-word `provider` swap in
 * schema.prisma that `npm run db:use-postgres` performs.
 *
 * Both adapters are listed in `serverExternalPackages` (next.config.ts) so their
 * native bindings are loaded at runtime instead of being bundled.
 */
function createAdapter() {
  if (isPostgres) {
    return new PrismaPg({
      connectionString: env.databaseUrl,
      // Serverless-friendly pool: small, and recycle idle connections quickly.
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return new PrismaBetterSqlite3({ url: env.databaseUrl });
}

function createClient() {
  return new PrismaClient({
    adapter: createAdapter(),
    log: isProduction ? ["error"] : ["error", "warn"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createClient>;
};

export const db = globalForPrisma.prisma ?? createClient();

// Next.js hot-reloads server modules in dev; without this every save would open
// another connection pool until the database refuses new ones.
if (!isProduction) globalForPrisma.prisma = db;

/**
 * A case-insensitive "contains" filter that behaves the same on both engines.
 *
 * Two engine differences are handled here, both found by running
 * `scripts/db-differences.ts` against a real PostgreSQL 17 server rather than
 * by reading documentation:
 *
 * 1. **Case.** Prisma compiles `contains` to `LIKE`. SQLite's `LIKE` is
 *    case-insensitive for ASCII; PostgreSQL's is not — so search verified in
 *    development would quietly start missing results in production.
 *    `mode: "insensitive"` fixes it on PostgreSQL and is rejected outright by
 *    the SQLite connector, so it is applied conditionally.
 *
 * 2. **Wildcards.** Prisma does not escape `%` or `_` in a search term, on
 *    either engine. A user searching for `RFP_2026_014` — a real shape for a
 *    solicitation number — matches `RFPX2026Y014` too, and a search for `%`
 *    matches every row in the workspace. PostgreSQL honours a backslash escape
 *    by default, so the term is escaped there. **SQLite has no default escape
 *    character**: the same escaped term matches nothing, so the term is left
 *    alone and the wildcard behaviour remains in development only. The
 *    denial-of-service half is closed for both engines in
 *    `src/lib/validation/common.ts`, which rejects a search term made only of
 *    wildcards.
 *
 * Scale note: on PostgreSQL this compiles to `ILIKE`, which a plain btree index
 * cannot serve. The trigram indexes in
 * prisma/postgres/001_search_indexes.sql are what keep it fast past a few
 * thousand rows; see docs/DEPLOYMENT-CHECKLIST.md.
 */
export function contains(value: string) {
  return isPostgres
    ? ({ contains: escapeLike(value), mode: "insensitive" } as const)
    : ({ contains: value } as const);
}

/**
 * Escapes the LIKE metacharacters so a search term is matched literally.
 *
 * Backslash first, or the escapes added below would themselves be escaped.
 * Only correct where the engine treats backslash as the default LIKE escape
 * character, which PostgreSQL does and SQLite does not.
 */
/**
 * Whether a term is worth running a substring search for.
 *
 * A term made only of LIKE wildcards and whitespace matches every row, so it is
 * treated as no filter at all rather than as the most expensive query in the
 * product. Applied at the data layer so every list and the search endpoint get
 * it, not only the ones that happen to parse through `zSearchQuery`.
 */
export function isSearchable(value: string | null | undefined): value is string {
  return typeof value === "string" && /[^%_\s]/.test(value);
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
