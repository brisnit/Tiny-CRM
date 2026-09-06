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
