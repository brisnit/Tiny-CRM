/**
 * Finding the table inside a spreadsheet somebody actually works in.
 *
 * An export from another CRM is a clean grid: header on row one, data below.
 * A spreadsheet a business is *run* from is not. It opens with a title, a
 * paragraph explaining what the tab is for, an instruction about which cells
 * are safe to edit, and a blank row. Underneath the data there are footnotes.
 * Beside the data tab there is a rollup tab that is entirely formulas.
 *
 * Every function here is pure and takes a `string[][]` grid, so the same
 * detection runs over CSV and over a workbook sheet without knowing which it
 * came from, and can be tested against real files without a database.
 *
 * Nothing here guesses about *meaning* — that is `mapping.ts`. This only
 * decides which rectangle of cells is the table.
 */

/** A sheet as it arrives from a parser, before we know anything about it. */
export type RawSheet = {
  name: string;
  rows: string[][];
};

export type SheetShape =
  /** A header row with records under it — the thing we can import. */
  | "records"
  /** Formulas and labels summarising another sheet. Nothing to import. */
  | "summary"
  /** Nothing that looks like a table at all. */
  | "empty";

export type DetectedTable = {
  name: string;
  shape: SheetShape;
  /** Why we decided that, in words a person can check. */
  reason: string;
  /** Index into the original grid of the row we think is the header. */
  headerRow: number;
  headers: string[];
  /** Data rows, already trimmed of preamble and trailing notes. */
  rows: string[][];
  /** Rows above the header, kept so the UI can show what was skipped. */
  preamble: string[][];
  /** Rows below the data that did not look like records. */
  trailing: string[][];
};

const nonEmpty = (row: string[]) => row.filter((cell) => cell.trim() !== "").length;

/**
 * Scores a row on how much it looks like a header.
 *
 * Headers are short, mostly distinct, mostly non-numeric, and wide relative to
 * the rows beneath them. A prose row — "Sourced from the RFPMart weekly digest
 * of 25/Aug/2026 (1,169 listings...)" — is one very long cell and scores badly
 * on every count, which is the point: it is the row most likely to be mistaken
 * for a header, because it is the first row with text in it.
 */
function headerScore(row: string[], following: string[][]): number {
  const filled = row.map((c) => c.trim()).filter((c) => c !== "");
  if (filled.length < 2) return 0;

  const distinct = new Set(filled.map((c) => c.toLowerCase())).size / filled.length;
  const numeric = filled.filter((c) => /^-?[\d.,$%]+$/.test(c)).length / filled.length;
  const longCells = filled.filter((c) => c.length > 60).length / filled.length;
  const averageLength = filled.reduce((sum, c) => sum + c.length, 0) / filled.length;

  // How many cells the rows underneath actually use. A header that is wider
  // than everything below it is usually a title spanning merged cells.
  const bodyWidth = following.length
    ? following.reduce((max, r) => Math.max(max, nonEmpty(r)), 0)
    : filled.length;
  const widthFit = bodyWidth === 0 ? 0 : Math.min(filled.length, bodyWidth) / Math.max(filled.length, bodyWidth);

  return (
    distinct * 0.3 +
    (1 - numeric) * 0.25 +
    (1 - longCells) * 0.2 +
    widthFit * 0.15 +
    (averageLength > 0 && averageLength <= 40 ? 0.1 : 0)
  );
}

/**
 * True when a row is prose rather than a record.
 *
 * The footnotes under a real table look like this: one cell carrying a
 * paragraph, every other cell blank. Treating them as records produces a row
 * whose "RFP ID" is three sentences long.
 */
function looksLikeProse(row: string[], columns: number): boolean {
  const filled = row.map((c) => c.trim()).filter((c) => c !== "");
  if (filled.length !== 1 || columns <= 2) return false;

  const text = filled[0]!;
  // Length alone is not enough. "Footnote: unpurchased listings were removed on
  // 08-Sep-2026." is under sixty characters and is still a footnote, while a
  // record's first cell is an identifier or a name — short, and rarely a
  // sentence. So a lone cell in a wide table is prose when it is long, or when
  // it reads like a sentence: several words and some punctuation.
  if (text.length > 120) return true;
  const words = text.split(/\s+/).length;
  return words >= 6 && /[.:;]/.test(text);
}

/**
 * Decides what a sheet is and where its table starts.
 *
 * Only the first 40 rows are considered for the header, because a header
 * further down than that means something is wrong with the file rather than
 * with the search.
 */
export function detectTable(sheet: RawSheet): DetectedTable {
  const grid = sheet.rows;
  const empty: DetectedTable = {
    name: sheet.name,
    shape: "empty",
    reason: "No rows with content.",
    headerRow: -1,
    headers: [],
    rows: [],
    preamble: [],
    trailing: [],
  };

  if (!grid.some((row) => nonEmpty(row) > 0)) return empty;

  let bestIndex = -1;
  let bestScore = 0;
  const searchLimit = Math.min(grid.length, 40);
  for (let i = 0; i < searchLimit; i++) {
    const row = grid[i]!;
    if (nonEmpty(row) < 2) continue;
    const score = headerScore(row, grid.slice(i + 1, i + 12));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) return empty;

  const headers = grid[bestIndex]!.map((c) => c.trim());
  const width = headers.filter((h) => h !== "").length;
  const body = grid.slice(bestIndex + 1);

  // Walk the body and stop counting records once the rows stop looking like
  // records. Everything after that is kept separately rather than dropped, so
  // the preview can show exactly what was left out.
  const rows: string[][] = [];
  const trailing: string[][] = [];
  let ended = false;
  for (const row of body) {
    if (ended) {
      if (nonEmpty(row) > 0) trailing.push(row);
      continue;
    }
    if (nonEmpty(row) === 0) continue;
    if (looksLikeProse(row, width)) {
      ended = true;
      trailing.push(row);
      continue;
    }
    rows.push(row);
  }

  const shape = classifyShape(headers, rows, width);
  return {
    name: sheet.name,
    shape: shape.shape,
    reason: shape.reason,
    headerRow: bestIndex,
    headers,
    rows,
    preamble: grid.slice(0, bestIndex).filter((row) => nonEmpty(row) > 0),
    trailing,
  };
}

/**
 * Records or summary.
 *
 * A rollup tab is narrow — a label, a number, a note — and its left column is
 * a list of distinct captions rather than repeated record values. Importing
 * one produces a "company" called "Closing within 7 days", so the distinction
 * is worth drawing explicitly rather than leaving to the person to notice.
 */
function classifyShape(
  headers: string[],
  rows: string[][],
  width: number,
): { shape: SheetShape; reason: string } {
  if (rows.length === 0) {
    return { shape: "empty", reason: "A header was found but no rows under it." };
  }

  if (width <= 3) {
    const numericSecond = rows.filter((r) => /^-?[\d.,$%]+$/.test((r[1] ?? "").trim())).length;
    if (numericSecond / rows.length > 0.5) {
      return {
        shape: "summary",
        reason:
          `${width} columns, and most rows are a label with a single number. ` +
          "This reads as a rollup of another sheet rather than records.",
      };
    }
  }

  return {
    shape: "records",
    reason: `${rows.length} row${rows.length === 1 ? "" : "s"} under a ${width}-column header.`,
  };
}
