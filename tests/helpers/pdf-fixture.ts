/**
 * Deterministic PDF fixtures for the Document Intelligence suites.
 *
 * Builds real PDFs with a correct cross-reference table, so the extractor is
 * exercised against documents a reader would accept rather than against bytes
 * that merely start with %PDF.
 *
 * Generated rather than committed as binaries for two reasons: the exact text
 * on each page is visible in this file, so a provenance assertion can name the
 * phrase it expects and the page it expects it on; and a scanned document can
 * be produced on demand — `imageOnlyPages` renders no text at all — which is
 * otherwise awkward to obtain without shipping a real scan of something.
 */

/** Escapes the three characters that are special inside a PDF string literal. */
function pdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** One page's content stream: a heading, then body lines, laid out top-down. */
function contentStream(lines: string[]): string {
  const out: string[] = ["BT", "/F1 14 Tf", "72 720 Td"];
  lines.forEach((line, index) => {
    if (index > 0) out.push("0 -22 Td");
    // A separate Tj per line, so each page has several text items rather than
    // one — which is what a real document looks like to the extractor.
    out.push(`(${pdfString(line)}) Tj`);
  });
  out.push("ET");
  return out.join("\n");
}

/**
 * A multi-page PDF. `pages[i]` is the list of text lines on page i+1.
 *
 * `imageOnlyPages` render no text at all — a stand-in for a scanned page, which
 * is what the no-text classification has to recognise. It is a list of **page
 * numbers, from 1**, matching `ExtractedPage.pageNumber` rather than the index
 * into `pages`. Passing 0-based indices silently shifts which pages are blank
 * and produces a document one page off from the one the test meant to build.
 */
export function buildPdf(pages: string[][], options: { imageOnlyPages?: number[] } = {}): Buffer {
  const imageOnly = new Set(options.imageOnlyPages ?? []);
  const objects: string[] = [];

  // 1 catalog, 2 pages, 3 font, then (page, contents) pairs from 4.
  const pageObjNum = (i: number) => 4 + i * 2;
  const contentObjNum = (i: number) => 5 + i * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ")}] ` +
    `/Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((lines, i) => {
    objects[pageObjNum(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentObjNum(i)} 0 R ` +
      `/Resources << /Font << /F1 3 0 R >> >> >>`;

    // An image-only page still has a content stream; it simply draws no text,
    // exactly as a scanned page's text layer is absent.
    const stream = imageOnly.has(i + 1) ? "" : contentStream(lines);
    objects[contentObjNum(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xref = Buffer.byteLength(out, "latin1");
  const count = objects.length; // objects.length - 1 real objects, plus slot 0
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) {
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

/** The known-good document the spike's correctness claims rest on. */
export const KNOWN_GOOD_PAGES: string[][] = [
  [
    "Tiny CRM Document Intelligence Extraction Test",
    "",
    "This fixture exists to prove that page-aware text survives extraction.",
    "It contains headings, paragraphs, punctuation, and numbers (1, 2, 3).",
    "Section 1.0 - Overview",
    "The document is deterministic: every run produces identical bytes.",
  ],
  [
    "Submission deadline: September 28, 2026 at 3:00 PM Pacific Time.",
    "",
    "Section 2.0 - Timeline",
    "Questions are due September 14, 2026 by 5:00 PM.",
    "Addenda, if any, will be issued no later than September 21, 2026.",
    "Late submissions will not be accepted under any circumstances.",
  ],
  [
    "Required deliverables: technical proposal, cost proposal, and three client references.",
    "",
    "Section 3.0 - Submission Requirements",
    "Proposals must not exceed 40 pages, excluding appendices.",
    "Insurance: $2,000,000 general liability; $1,000,000 professional liability.",
    "Contact: procurement@example.gov (909) 555-0142.",
  ],
];
