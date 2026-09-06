import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, type Prisma } from "@/generated/prisma/client";
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
 *
 * The SQLite adapter is required lazily rather than imported at the top of this
 * module, because importing it eagerly pulls better-sqlite3's native `.node`
 * binary into the require cache on every cold start — including in a serverless
 * production deployment that only ever speaks PostgreSQL. Verified: requiring
 * `@prisma/adapter-better-sqlite3` loads better-sqlite3 as a side effect. This
 * keeps a native module that production never uses off the cold-start path.
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3") as
    typeof import("@prisma/adapter-better-sqlite3");
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

const baseClient = globalForPrisma.prisma ?? createClient();

// Next.js hot-reloads server modules in dev; without this every save would open
// another connection pool until the database refuses new ones.
if (!isProduction) globalForPrisma.prisma = baseClient;

/**
 * The ambient tenant transaction, if this unit of work is inside one.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Row-level security only filters a statement that carries tenant context, and
 * that context is `SET LOCAL` — scoped to one transaction on one connection.
 * So every workspace-scoped query has to run inside the transaction that set
 * it. There are 362 `db.<model>` call sites across 75 files; requiring each one
 * to receive and thread a transaction client is a refactor with 362 chances to
 * miss one, and a missed one fails *open* on SQLite and *closed* on PostgreSQL
 * — the second being how a deployment discovers the problem in production.
 *
 * Instead `db` is a proxy. Inside `withTenantContext` it resolves to that
 * transaction's client, so existing call sites participate in RLS without
 * changing; outside one it resolves to the base client, which under RLS can
 * only reach the tables deliberately left out of it. The decision is made in
 * one place and cannot be forgotten at a call site.
 *
 * AsyncLocalStorage is per async execution context, so two concurrent requests
 * on the same pooled connection cannot observe each other's store — which is
 * the property the pooled-isolation test asserts directly.
 */
const tenantTx = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Runs `fn` with `tx` as the ambient client for every `db` access inside it. */
export function runWithTenantClient<T>(tx: Prisma.TransactionClient, fn: () => Promise<T>): Promise<T> {
  return tenantTx.run(tx, fn);
}

/**
 * Runs `fn` with no ambient tenant transaction.
 *
 * Work that is deliberately detached from the request — a fire-and-forget alert
 * delivery, a background dispatch — keeps the AsyncLocalStorage store of
 * whatever scope created it, but the transaction that store points at has
 * already committed by the time the work runs. Reusing it then fails with
 * "Transaction already closed". Detached work must therefore leave the ambient
 * context and open its own.
 */
export function runDetached<T>(fn: () => Promise<T>): Promise<T> {
  return tenantTx.exit(fn);
}

/** The ambient tenant transaction client, or null outside one. */
export function currentTenantClient(): Prisma.TransactionClient | null {
  return tenantTx.getStore() ?? null;
}

type Client = typeof baseClient;

export const db: Client = new Proxy(baseClient, {
  get(target, property, receiver) {
    const tx = tenantTx.getStore();
    if (!tx) return Reflect.get(target, property, receiver);

    // Prisma forbids a nested $transaction. Inside a tenant transaction the
    // atomicity the caller wants is already provided by the outer one, so an
    // interactive $transaction is flattened onto it. Flattening rather than
    // failing keeps existing helpers — including base.ts's `transaction()` —
    // working unchanged, and the semantics still hold: a throw rolls the whole
    // outer transaction back.
    if (property === "$transaction") {
      return (arg: unknown) => {
        if (typeof arg === "function") return (arg as (c: unknown) => unknown)(tx);
        // The array form is a batch; run them in order on this transaction.
        if (Array.isArray(arg)) return Promise.all(arg);
        return Reflect.get(target, property, receiver);
      };
    }

    // $connect/$disconnect/$on belong to the pool, not to a transaction.
    if (typeof property === "string" && /^\$(connect|disconnect|on|use|extends)$/.test(property)) {
      return Reflect.get(target, property, receiver);
    }

    if (property in tx) return (tx as unknown as Record<string | symbol, unknown>)[property];
    return Reflect.get(target, property, receiver);
  },
}) as Client;

/**
 * The pool itself, bypassing any ambient tenant transaction.
 *
 * Only for work that must not join the caller's transaction: startup checks,
 * the health endpoint, and `withTenantContext` opening the transaction in the
 * first place. Never for workspace-scoped data — `tests/security/rls.test.ts`
 * asserts the list of files allowed to import it.
 */
export const rootDb = baseClient;

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
