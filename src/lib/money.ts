/**
 * Money is stored as integer minor units (cents). Floats are never used for
 * currency arithmetic, and no Decimal column is required, which keeps the
 * schema portable across SQLite and PostgreSQL.
 */

export function toCents(amount: number | string | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  const value = typeof amount === "string" ? Number(amount.replace(/[^0-9.-]/g, "")) : amount;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export function fromCents(cents: number | null | undefined): number {
  return (cents ?? 0) / 100;
}

const compact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const full = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const precise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$1.2M" — for dashboard tiles and pipeline headers where space is tight. */
export function formatCompact(cents: number | null | undefined) {
  return compact.format(fromCents(cents));
}

/** "$1,200,000" — the default for tables and record headers. */
export function formatMoney(cents: number | null | undefined) {
  return full.format(fromCents(cents));
}

/** "$1,200,000.00" — for inputs and anywhere exactness is the point. */
export function formatMoneyPrecise(cents: number | null | undefined) {
  return precise.format(fromCents(cents));
}
