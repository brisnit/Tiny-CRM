import "server-only";

import type { ExtractedDocument } from "@/lib/documents/extract";

/**
 * How readable a document turned out to be.
 *
 * This is a **classification, not a truth**. It reads the shape of what came
 * out of extraction and guesses at the cause, and it will sometimes be wrong in
 * both directions. What it is for is making Tiny say "I couldn't read this"
 * instead of confidently answering questions about a document it never read —
 * and the honest failure is much cheaper than the confident one.
 *
 * OCR is explicitly out of scope. When this returns `no_text` the product's job
 * is to say so plainly, not to guess at the contents.
 */
export type ClassifiedStatus = "ready" | "partial_text" | "no_text";

export type Classification = {
  status: ClassifiedStatus;
  pagesWithText: number;
  charsPerPage: number;
};

/** A page with fewer than this is a header or a page number, not content. */
const MIN_PAGE_CHARS = 20;
/** Below this share of readable pages, treat the document as partly unreadable. */
const MIN_TEXT_PAGE_RATIO = 0.5;
/** Average characters per page below which a document reads like a scan. */
const MIN_CHARS_PER_PAGE = 100;
/** Fewer pages than this and averaging tells you nothing useful. */
const DENSITY_MIN_PAGES = 5;

export function classify(doc: ExtractedDocument): Classification {
  const pagesWithText = doc.pages.filter((p) => p.charCount >= MIN_PAGE_CHARS).length;
  const charsPerPage = doc.pageCount === 0 ? 0 : Math.round(doc.charCount / doc.pageCount);
  const ratio = doc.pageCount === 0 ? 0 : pagesWithText / doc.pageCount;

  // Nothing readable anywhere. A scan, or a PDF of pure imagery.
  if (pagesWithText === 0) return { status: "no_text", pagesWithText, charsPerPage };

  // Density is only meaningful once there are enough pages to average over.
  //
  // The first version of this rule applied it unconditionally and classified a
  // one-page document reading "Invoice 4102. Paid in full." as partial_text.
  // Twenty-seven characters is thin for a page and entirely normal for that
  // document. Below the threshold only the ratio applies, so a short document
  // is judged on whether its pages have text at all rather than on how much.
  //
  // The cost of that decision is visible and worth stating: a two-page mostly
  // scanned certificate with a little text on both pages classifies as `ready`.
  // Under five pages this heuristic does not attempt to catch that, because the
  // alternative rejects legitimate short documents, and wrongly refusing to
  // read a real document is the worse failure.
  if (doc.pageCount >= DENSITY_MIN_PAGES) {
    // Both signals matter. A scan whose only text layer is a page number has
    // text on every page — ratio 1.0 — and is still unreadable, which is what
    // the density floor catches.
    if (ratio < MIN_TEXT_PAGE_RATIO || charsPerPage < MIN_CHARS_PER_PAGE) {
      return { status: "partial_text", pagesWithText, charsPerPage };
    }
  } else if (ratio < MIN_TEXT_PAGE_RATIO) {
    return { status: "partial_text", pagesWithText, charsPerPage };
  }

  return { status: "ready", pagesWithText, charsPerPage };
}
