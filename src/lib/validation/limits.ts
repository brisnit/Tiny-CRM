/**
 * Hard ceilings on anything a client can influence.
 *
 * A browser must never be able to ask for `limit=10000000` and take the server
 * with it. These are the single source of truth for every bound in the app —
 * page sizes, string lengths, batch sizes, upload sizes and AI context — so a
 * limit can be reviewed in one place rather than rediscovered per endpoint.
 */
export const LIMITS = {
  /** List pagination. */
  pageSize: { default: 50, max: 100 },
  /** Highest page number accepted, so OFFSET cannot be driven arbitrarily deep. */
  maxPage: 1_000,

  /** Free-text search. */
  searchQuery: { min: 1, max: 128 },
  /** Distinct filter clauses accepted on one request. */
  maxFilters: 12,

  /** Text field ceilings, enforced by Zod before anything reaches the database. */
  shortText: 200,
  mediumText: 1_000,
  longText: 10_000,
  richText: 200_000,

  /** Bulk operations. */
  maxBulkIds: 100,
  maxExportRows: 50_000,
  maxImportRows: 5_000,
  maxImportBytes: 5 * 1024 * 1024,

  /** File uploads. */
  maxUploadBytes: 25 * 1024 * 1024,

  /** AI. */
  maxAiQuestion: 4_000,
  maxAiHistoryTurns: 6,
  maxAiContextChars: 14_000,
  maxAiProposals: 50,

  /** Money, in minor units. Guards against overflow and absurd inputs. */
  maxMoneyCents: 1_000_000_000_00,

  /** Dates accepted from a client, as a sanity window. */
  minYear: 1900,
  maxYear: 2200,
} as const;

/** Clamps a page-size request into the permitted range. */
export function clampPageSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return LIMITS.pageSize.default;
  return Math.min(Math.max(Math.trunc(n), 1), LIMITS.pageSize.max);
}

/** Clamps a page number, rejecting deep-offset scans. */
export function clampPage(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.trunc(n), 1), LIMITS.maxPage);
}
