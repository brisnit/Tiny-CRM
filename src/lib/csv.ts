import { neutralizeCsvCell } from "@/lib/sanitize";

/**
 * Minimal, dependency-free CSV.
 *
 * Handles the cases that actually break imports — quoted fields containing
 * commas, newlines and escaped quotes — and, on export, neutralises spreadsheet
 * formula injection.
 */

/**
 * Serialises rows to CSV.
 *
 * Every cell passes through `neutralizeCsvCell` first. Without it, a contact
 * whose job title is `=HYPERLINK("http://attacker","Click")` becomes a live
 * formula the moment the export is opened in Excel or Sheets — an attack the
 * exporting user never sees coming, because the value looked like text in the
 * CRM (F-13).
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const keys = columns ?? Object.keys(rows[0]!);

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = value instanceof Date ? value.toISOString() : String(value);
    const safe = neutralizeCsvCell(text);
    return /[",\n\r\t]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  return [
    keys.join(","),
    ...rows.map((row) => keys.map((key) => escape(row[key])).join(",")),
  ].join("\n");
}

export type ParseOptions = {
  /** Hard ceiling on rows, so a hostile file cannot exhaust memory. */
  maxRows?: number;
  /** Hard ceiling on input size in bytes. */
  maxBytes?: number;
};

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/**
 * Parses CSV into records.
 *
 * Bounded by row count and byte length: an unbounded parser is a denial-of-
 * service primitive, and this one is reachable from an upload form.
 */
export function parseCsv(text: string, options: ParseOptions = {}): Record<string, string>[] {
  const maxRows = options.maxRows ?? 10_000;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new CsvError(`That file is larger than ${Math.round(maxBytes / 1024 / 1024)}MB.`);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const input = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      // +1 for the header row.
      if (rows.length > maxRows + 1) {
        throw new CsvError(`That file has more than ${maxRows.toLocaleString()} rows.`);
      }
    } else field += char;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!header) return [];

  // A file with hundreds of columns is malformed, not ambitious.
  if (header.length > 200) throw new CsvError("That file has too many columns.");

  const keys = header.map((h) => h.trim().slice(0, 200));
  return body.map((cells) =>
    Object.fromEntries(keys.map((key, i) => [key, (cells[i] ?? "").trim().slice(0, 5000)])),
  );
}

/**
 * Maps arbitrary CSV headers onto our fields. Import files come from HubSpot,
 * Salesforce, Google Contacts and hand-rolled spreadsheets, so the matcher is
 * deliberately forgiving about casing, spacing and punctuation.
 */
export function matchColumn(headers: string[], candidates: string[]): string | null {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalised = headers.map((h) => ({ raw: h, key: normalise(h) }));
  for (const candidate of candidates) {
    const target = normalise(candidate);
    const exact = normalised.find((h) => h.key === target);
    if (exact) return exact.raw;
  }
  for (const candidate of candidates) {
    const target = normalise(candidate);
    const partial = normalised.find((h) => h.key.includes(target));
    if (partial) return partial.raw;
  }
  return null;
}
