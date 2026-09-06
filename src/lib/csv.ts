/**
 * Minimal, dependency-free CSV. Handles the cases that actually break imports:
 * quoted fields containing commas, newlines and escaped quotes.
 */

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const keys = columns ?? Object.keys(rows[0]!);
  const escape = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [keys.join(","), ...rows.map((row) => keys.map((key) => escape(row[key])).join(","))].join("\n");
}

export function parseCsv(text: string): Record<string, string>[] {
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
    } else field += char;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!header) return [];

  const keys = header.map((h) => h.trim());
  return body.map((cells) =>
    Object.fromEntries(keys.map((key, i) => [key, (cells[i] ?? "").trim()])),
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
