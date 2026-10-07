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

/**
 * Wrapping lines so that none of them is painted off the page.
 *
 * **Text painted outside the page box is not extracted.** It is not clipped from
 * the file and it is not an error; a reader never sees it, and pdf.js reports
 * what a reader would see. So a fixture line wider than the page used to come
 * back silently truncated — a 96-character sentence extracted as 89 characters,
 * cut mid-word, with no warning. Found while building a dense corpus for the
 * document Q&A model check, where it presented as retrieval citing the correct
 * page for a sentence that was not in the extracted text.
 *
 * Wrapping on a character count is not enough, and that is the second thing this
 * had to learn: `W` is 0.944em in Helvetica where lowercase prose averages about
 * 0.45em, so seventy-two characters of capitals is nearly twice the width of
 * seventy-two characters of prose and runs off the page again. So the wrap
 * measures width rather than counting characters, with a deliberately generous
 * per-character estimate — over-estimating wraps a line early, which is
 * harmless, while under-estimating loses text, which is the bug.
 */
const FONT_SIZE_PT = 14;
/** 612pt MediaBox, inset 72pt on the left, with a 72pt right margin. */
const TEXT_WIDTH_PT = 612 - 72 - 72;

/**
 * Helvetica advance widths for printable ASCII, in 1/1000 em.
 *
 * The real table from the font's own metrics, not an estimate. A first attempt
 * used width classes — 0.95em for capitals, 0.6em for everything else — and it
 * was wrong in the expensive direction: it over-estimated an ordinary line by
 * about forty percent and wrapped text that fits, which broke an existing
 * assertion that a phrase appears contiguously on one page. Over-estimating is
 * not "safe" here; it just moves the damage from losing text to reflowing it.
 *
 * Indexed from space (0x20) to tilde (0x7e). Anything outside that range falls
 * back to the widest entry, since the builder writes latin1 and an exotic
 * character is rare enough that wrapping early is the right trade.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // ' ' .. '/'
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // '0' .. '?'
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // '@' .. 'O'
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 'P' .. '_'
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // '`' .. 'o'
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // 'p' .. '~'
] as const;

const WIDEST_WIDTH = 1015;

/** One glyph's advance, in points. */
function glyphWidth(ch: string): number {
  const code = ch.charCodeAt(0);
  const index = code - 0x20;
  const thousandths =
    index >= 0 && index < HELVETICA_WIDTHS.length ? HELVETICA_WIDTHS[index]! : WIDEST_WIDTH;
  return (thousandths / 1000) * FONT_SIZE_PT;
}

function lineWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += glyphWidth(ch);
  return total;
}

/** Breaks one logical line at word boundaries so none of it falls off the page. */
function wrapLine(line: string): string[] {
  if (lineWidth(line) <= TEXT_WIDTH_PT) return [line];

  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) out.push(current);
    current = "";
  };

  for (const word of line.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (lineWidth(candidate) <= TEXT_WIDTH_PT) {
      current = candidate;
      continue;
    }
    flush();
    current = word;
    // A single word too wide to fit on its own cannot be broken at a space.
    // Hard-break it rather than let its tail fall off the page.
    while (lineWidth(current) > TEXT_WIDTH_PT) {
      let taken = "";
      for (const ch of current) {
        if (lineWidth(taken + ch) > TEXT_WIDTH_PT) break;
        taken += ch;
      }
      out.push(taken);
      current = current.slice(taken.length);
    }
  }
  flush();
  return out;
}

/** One page's content stream: a heading, then body lines, laid out top-down. */
function contentStream(lines: string[]): string {
  const out: string[] = ["BT", "/F1 14 Tf", "72 720 Td"];
  lines.flatMap(wrapLine).forEach((line, index) => {
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
