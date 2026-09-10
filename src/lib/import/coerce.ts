/**
 * Turning a spreadsheet cell into a value, or refusing to.
 *
 * The rule every function here follows: **flag, never guess.** A cell reading
 * "Millions" in a money column is not zero and is not ignorable — it is a real
 * thing the person wrote, and the only honest outcomes are to keep it as a
 * note or to ask. Silently coercing it to a number would put a wrong figure in
 * a pipeline total, which is worse than importing nothing.
 *
 * So every coercion returns a verdict rather than a value: `ok` with the
 * parsed result, or `unparsed` with the original text and a reason the preview
 * can show. Callers decide what to do; nothing here decides on its own.
 */

export type Coerced<T> =
  | { ok: true; value: T | null; note?: string }
  | { ok: false; raw: string; reason: string };

/** A cell that is blank, or one of the several ways people write "no value". */
const BLANK = new Set(["", "-", "—", "–", "n/a", "na", "none", "null", "tbd", "unknown", "?"]);

export function isBlank(raw: string): boolean {
  return BLANK.has(raw.trim().toLowerCase());
}

/**
 * Formula injection, neutralised on the way *in*.
 *
 * The export path already does this. The import path did not, so a cell
 * reading `=HYPERLINK("http://attacker","Click")` was stored verbatim and
 * became a live formula for whoever exported it later — or for anyone who
 * opened a CSV Tiny generated from it. Neutralising on ingest means the stored
 * value is inert no matter which way it leaves again.
 *
 * A leading apostrophe is Excel's own "treat as text" marker and is stripped
 * first, because a value that arrives already escaped should not accumulate a
 * second escape on every round trip.
 */
export function neutralizeCell(raw: string): string {
  const value = raw.replace(/^'/, "");
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Dates.
 *
 * ISO first, because that is what an export produces. Then the unambiguous
 * written forms. Deliberately absent: any attempt to read `03/04/2026`, which
 * is March in one country and April in another and cannot be resolved from the
 * cell alone. Those come back unparsed with the ambiguity named, so the person
 * can say which they meant instead of discovering the wrong answer in a
 * deadline three weeks later.
 */
export function coerceDate(raw: string): Coerced<Date> {
  const text = raw.trim();
  if (isBlank(text)) return { ok: true, value: null };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    // `Date.UTC` rolls out-of-range components over rather than rejecting them:
    // month 13 day 45 becomes a perfectly valid day in the following year, and
    // a deadline lands months away from what the file said. Checking the parts
    // survive the round trip is what actually catches it.
    const rolled =
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day;
    if (Number.isNaN(date.getTime()) || rolled) {
      return { ok: false, raw: text, reason: "Looks like a date but is not a real one." };
    }
    return { ok: true, value: date };
  }

  // "15 Sep 2026", "Sep 15, 2026", "September 15 2026"
  const written = /^(\d{1,2}\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})?,?\s*(\d{4})$/.exec(text);
  if (written) {
    const parsed = new Date(`${text} UTC`);
    if (!Number.isNaN(parsed.getTime())) return { ok: true, value: parsed };
  }

  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
    return {
      ok: false,
      raw: text,
      reason: "Ambiguous date — could be day/month or month/day. Confirm the format.",
    };
  }

  return { ok: false, raw: text, reason: "Not a date we recognise." };
}

/**
 * Money, in minor units, because that is how the schema stores it.
 *
 * Ranges and prose are refused rather than flattened. "$30,000-$40,000" has no
 * single correct answer — taking the low end understates the pipeline and the
 * high end overstates it — and "Millions" is not a number at all. Both come
 * back unparsed so the value survives as a note instead of becoming a figure
 * nobody chose.
 */
export function coerceMoneyCents(raw: string): Coerced<number> {
  const text = raw.trim();
  if (isBlank(text)) return { ok: true, value: null };

  if (/\d\s*[-–—]\s*\$?\d/.test(text)) {
    return {
      ok: false,
      raw: text,
      reason: "A range, not a single amount. Pick one, or keep it as a note.",
    };
  }

  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, raw: text, reason: "Not an amount." };
  }

  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, raw: text, reason: "That amount is out of range." };
  }
  return { ok: true, value: cents };
}

/** Whole numbers, for scores and counts. */
export function coerceInt(raw: string, min?: number, max?: number): Coerced<number> {
  const text = raw.trim();
  if (isBlank(text)) return { ok: true, value: null };

  const cleaned = text.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false, raw: text, reason: "Not a number." };

  const value = Math.round(Number(cleaned));
  if (min != null && value < min) return { ok: false, raw: text, reason: `Below ${min}.` };
  if (max != null && value > max) return { ok: false, raw: text, reason: `Above ${max}.` };
  return { ok: true, value };
}

const TRUE = new Set(["true", "yes", "y", "1", "x", "✓", "checked"]);
const FALSE = new Set(["false", "no", "n", "0", ""]);

/**
 * Booleans, across the several vocabularies one workbook will use at once.
 *
 * The tracker this was written against uses "Yes"/"No" in two columns and
 * "TRUE"/"FALSE" in four others, and has a single cell reading "not yet" —
 * which is a person hedging, not a boolean, and comes back unparsed.
 */
export function coerceBoolean(raw: string): Coerced<boolean> {
  const text = raw.trim().toLowerCase();
  if (isBlank(text) && text !== "0") return { ok: true, value: null };
  if (TRUE.has(text)) return { ok: true, value: true };
  if (FALSE.has(text)) return { ok: true, value: false };
  return { ok: false, raw, reason: "Not a yes or a no." };
}

/**
 * A value that has to be one of a fixed set.
 *
 * Matching is forgiving about case, spacing and punctuation, because "BID
 * SUBMITTED" and "bid_submitted" are the same intent. What it will not do is
 * pick the closest option: a status of "Sent Clarifying Questions" does not
 * silently become "drafting". It comes back unparsed with the options listed,
 * and the person maps it once in the preview.
 */
export function coerceEnum(
  raw: string,
  options: readonly string[],
  aliases: Record<string, string> = {},
): Coerced<string> {
  const text = raw.trim();
  if (isBlank(text)) return { ok: true, value: null };

  const key = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const option of options) {
    if (option.toLowerCase().replace(/[^a-z0-9]/g, "") === key) return { ok: true, value: option };
  }
  for (const [alias, option] of Object.entries(aliases)) {
    if (alias.toLowerCase().replace(/[^a-z0-9]/g, "") === key) {
      return { ok: true, value: option, note: `Read "${text}" as ${option}.` };
    }
  }
  return {
    ok: false,
    raw: text,
    reason: `Not one of: ${options.join(", ")}.`,
  };
}

/** Free text, bounded and made inert. */
export function coerceText(raw: string, max: number): Coerced<string> {
  const text = neutralizeCell(raw.trim());
  if (isBlank(raw)) return { ok: true, value: null };
  if (text.length <= max) return { ok: true, value: text };
  return {
    ok: true,
    value: text.slice(0, max),
    note: `Trimmed from ${text.length} to ${max} characters.`,
  };
}
