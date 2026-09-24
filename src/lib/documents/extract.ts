import "server-only";

import type { DocumentErrorCode } from "@/lib/enums";

/**
 * Server-side PDF text extraction.
 *
 * Reads page-aware text out of a PDF inside our own Node runtime, using the
 * `pdfjs-dist` already shipped for the browser viewer — no browser, no worker,
 * no canvas, no network.
 *
 * ---------------------------------------------------------------------------
 * This takes bytes, and will never take a storage key
 * ---------------------------------------------------------------------------
 *
 * An `extractPdf(storageKey)` shape would invite callers to name an object
 * directly, and would make the authorization boundary a matter of remembering
 * to check first. Bytes arrive from a caller that has already resolved an
 * authorized FileAsset under a tenant context. This module knows nothing about
 * workspaces, storage, buckets or credentials, and cannot leak what it does not
 * have.
 *
 * ---------------------------------------------------------------------------
 * Two things the Phase 3B spike established, which are not obvious
 * ---------------------------------------------------------------------------
 *
 * **pdf.js takes ownership of the buffer you hand it.** `getDocument({ data })`
 * transfers and detaches it. A caller holding the bytes for a retry finds them
 * gone, and passing the same buffer twice fails inside `structuredClone` with a
 * `DataCloneError` that names nothing useful. Hence the defensive copy below.
 *
 * **It needs `serverExternalPackages` to run inside Next.** In Node, pdf.js has
 * no real Worker and loads its worker code by importing `./pdf.worker.mjs`
 * relative to itself. Bundled into `.next/server/chunks/` that path resolves to
 * a file that is not there, and every extraction fails with "Setting up fake
 * worker failed" — while passing every test run under `tsx`. See next.config.ts,
 * where `pdfjs-dist` is externalised and the worker is explicitly traced.
 */

export type ExtractedPage = {
  pageNumber: number;
  text: string;
  /** Text items pdf.js reported. Zero is the signature of a scanned page. */
  itemCount: number;
  charCount: number;
  width: number;
  height: number;
};

export type ExtractedDocument = {
  pageCount: number;
  pages: ExtractedPage[];
  charCount: number;
  /** Anything notable that happened while reading. Kept, not swallowed. */
  warnings: string[];
};

/**
 * Bumped when a change to this module would produce different output for the
 * same bytes. Stored on every ingestion row so a future reprocessing pass can
 * find the stale ones instead of guessing.
 */
export const EXTRACTOR_VERSION = 1;

export type ExtractLimits = {
  maxPages: number;
  maxChars: number;
  timeoutMs: number;
};

export const DEFAULT_LIMITS: ExtractLimits = {
  /** Past this, a "document" is a data dump and not something to answer from. */
  maxPages: 500,
  /** ~2 MB of text. The 36-page RFP measured in the spike produced 73 kB. */
  maxChars: 2_000_000,
  /** Wall-clock ceiling for one document. The same RFP took 86 ms. */
  timeoutMs: 60_000,
};

/**
 * A failure with a category the product can render.
 *
 * The category is chosen by us from the exception *type*, never from its text.
 * A library or provider message can name a file path, a bucket or a request id,
 * and this value ends up on a row a browser will display.
 */
export class PdfExtractionError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

/**
 * Loads pdf.js for Node.
 *
 * The *legacy* build, not the one the viewer uses: the main build targets
 * modern browsers and assumes DOM globals. The legacy build polyfills
 * `DOMMatrix` and `Path2D` itself, which is why no DOM shim is needed here.
 */
async function loadPdfjs() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
}

export async function extractPdf(
  bytes: Uint8Array,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<ExtractedDocument> {
  if (!looksLikePdf(bytes)) {
    throw new PdfExtractionError("unsupported_type", "Not a PDF");
  }

  const pdfjs = await loadPdfjs();

  const task = pdfjs.getDocument({
    // A copy, deliberately — see the header. 25 MB is the upload ceiling, so
    // the copy is bounded.
    data: new Uint8Array(bytes),
    // Nothing may come from the network: everything must come from these bytes.
    // With no `standardFontDataUrl` or `cMapUrl` set there is nothing to fetch
    // either, so this is belt and braces.
    useWorkerFetch: false,
    // We never draw. Font machinery is pure cost here and a source of noise.
    disableFontFace: true,
    useSystemFonts: false,
    // XFA is a whole second document format with its own scripting. Off.
    enableXfa: false,
    // A no-op on pdfjs v6 — the option was removed, and the spike confirmed the
    // installed builds contain no `eval(` or `new Function(` at all, so the
    // protection it used to provide is now unconditional. Passed anyway so that
    // a future version which reintroduces it is configured correctly rather
    // than defaulting to permissive.
    isEvalSupported: false,
    verbosity: 0,
  });

  // The document's own JavaScript and open-actions are never requested.
  // pdf.js does not run them unless asked — `getJSActions()`, `getOpenAction()`
  // and the XFA path are the ways in, and none of them is called here or
  // anywhere else in this module. There is no code path from these bytes to
  // execution.

  const timeout = new Timeout(limits.timeoutMs);
  try {
    const doc = await timeout.race(task.promise, () => {
      throw new PdfExtractionError("internal", "Timed out opening the document");
    });

    try {
      return await readPages(doc, limits, timeout);
    } finally {
      // Best effort. A destroy that fails must not mask the real outcome.
      await task.destroy().catch(() => {});
    }
  } catch (error) {
    await task.destroy().catch(() => {});
    throw asExtractionError(error);
  } finally {
    timeout.clear();
  }
}

async function readPages(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  limits: ExtractLimits,
  timeout: Timeout,
): Promise<ExtractedDocument> {
  const warnings: string[] = [];
  const pageCount: number = doc.numPages;

  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new PdfExtractionError("unreadable", "The document reports no pages");
  }
  if (pageCount > limits.maxPages) {
    throw new PdfExtractionError(
      "too_large",
      `The document has ${pageCount} pages, more than the ${limits.maxPages} we read`,
    );
  }

  const pages: ExtractedPage[] = [];
  let total = 0;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    timeout.check(() => {
      throw new PdfExtractionError("internal", "Timed out reading the document");
    });

    let text = "";
    let itemCount = 0;
    let width = 0;
    let height = 0;

    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      width = Math.round(viewport.width);
      height = Math.round(viewport.height);

      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        parts.push(item.str);
        // pdf.js emits items in draw order with an end-of-line hint. Using it
        // keeps line boundaries without attempting layout analysis.
        if (item.hasEOL) parts.push("\n");
      }
      itemCount = content.items.length;
      text = normalise(parts.join(""));
      page.cleanup();
    } catch (error) {
      // One unreadable page does not make the document unreadable. Record it
      // and carry on — a damaged page 40 should not cost the reader pages 1-39.
      // The code, not the message: an exception's text can name a file path.
      warnings.push(`page_unreadable:${pageNumber}`);
      if (warnings.length > 50) {
        throw new PdfExtractionError("unreadable", "Too many pages failed to read", error);
      }
    }

    total += text.length;
    if (total > limits.maxChars) {
      throw new PdfExtractionError(
        "too_large",
        `The document holds more than ${limits.maxChars} characters of text`,
      );
    }

    pages.push({ pageNumber, text, itemCount, charCount: text.length, width, height });
  }

  return { pageCount, pages, charCount: total, warnings };
}

/**
 * Maps a thrown value onto a category we are willing to display.
 *
 * pdf.js exceptions are distinguished by their `name`, which is stable across
 * versions in a way their messages are not.
 */
function asExtractionError(error: unknown): PdfExtractionError {
  if (error instanceof PdfExtractionError) return error;

  const name = error instanceof Error ? error.name : "";

  // A password-protected document. Not damaged, not our failure, and not
  // something we will ever read — so it is "unsupported", not "failed".
  if (name === "PasswordException") {
    return new PdfExtractionError("encrypted", "The document is password protected", error);
  }
  if (name === "InvalidPDFException") {
    return new PdfExtractionError("unreadable", "The document is not a readable PDF", error);
  }
  if (name === "MissingPDFException") {
    return new PdfExtractionError("unreadable", "The document is empty or truncated", error);
  }
  // UnknownErrorException and anything else: ours until proven otherwise.
  return new PdfExtractionError("internal", "The document could not be read", error);
}

/** The five bytes every PDF starts with. Cheap, and rejects the obvious. */
function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

/**
 * Whitespace only. Not layout repair.
 *
 * Collapsing runs of spaces and trimming line ends makes the text usable for
 * chunking and for a model, while leaving the words and their order exactly as
 * the document had them.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A wall-clock budget for one document.
 *
 * Checked between pages and raced against the initial open. It bounds how long
 * we *wait*, which is what a job needs; it cannot preempt pdf.js mid-page, and
 * this does not pretend to. `task.destroy()` in the caller's `finally` is what
 * actually stops the work.
 */
class Timeout {
  private readonly deadline: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ms: number) {
    this.deadline = Date.now() + ms;
  }

  expired(): boolean {
    return Date.now() > this.deadline;
  }

  check(onExpired: () => never): void {
    if (this.expired()) onExpired();
  }

  async race<T>(promise: Promise<T>, onExpired: () => never): Promise<T> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) onExpired();

    let expire: () => void;
    const expired = new Promise<never>((_resolve, reject) => {
      expire = () => reject(new PdfExtractionError("internal", "Timed out"));
      this.timer = setTimeout(expire, remaining);
      // Do not hold the process open for a document nobody is waiting for.
      this.timer.unref?.();
    });

    try {
      return await Promise.race([promise, expired]);
    } catch (error) {
      if (this.expired()) onExpired();
      throw error;
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
