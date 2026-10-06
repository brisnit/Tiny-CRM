import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildPdf, KNOWN_GOOD_PAGES } from "../helpers/pdf-fixture";
import { extractPdf, PdfExtractionError, EXTRACTOR_VERSION } from "../../src/lib/documents/extract";
import { classify } from "../../src/lib/documents/classify";

/**
 * Reading a PDF on the server.
 *
 * The claims worth testing are not "pdf.js works" — that is pdf.js's problem —
 * but the ones this module adds on top: that page numbers survive, that a
 * caller's buffer survives, that malformed input fails as a category rather
 * than as a stack trace, and that a scanned document is reported honestly
 * instead of as an empty success.
 */

describe("extractPdf", () => {
  test("preserves page provenance exactly", async () => {
    const doc = await extractPdf(new Uint8Array(buildPdf(KNOWN_GOOD_PAGES)));

    assert.equal(doc.pageCount, 3);
    assert.equal(doc.pages.length, 3);
    assert.deepEqual(doc.pages.map((p) => p.pageNumber), [1, 2, 3]);

    // The specific claim: a phrase that is on page 2 is on page 2 and nowhere
    // else. Provenance that is merely usually right is worse than none, because
    // a citation is an invitation to go and check.
    const deadline = "Submission deadline: September 28, 2026";
    const pagesMentioning = doc.pages.filter((p) => p.text.includes(deadline)).map((p) => p.pageNumber);
    assert.deepEqual(pagesMentioning, [2], "the deadline phrase did not land on page 2 alone");
  });

  test("keeps punctuation, numbers and headings intact", async () => {
    const doc = await extractPdf(new Uint8Array(buildPdf(KNOWN_GOOD_PAGES)));
    const all = doc.pages.map((p) => p.text).join("\n");

    for (const phrase of [
      "Section 1.0 - Overview",
      "numbers (1, 2, 3)",
      "3:00 PM Pacific Time",
    ]) {
      assert.ok(all.includes(phrase), `extraction lost "${phrase}"`);
    }
  });

  test("does not consume the caller's buffer", async () => {
    // pdf.js transfers ownership of the buffer it is given and detaches it. A
    // caller retrying after a transient failure would find its bytes gone, and
    // the second call dies inside structuredClone with a DataCloneError that
    // names nothing useful. The extractor copies; this proves the copy is there.
    const bytes = new Uint8Array(buildPdf(KNOWN_GOOD_PAGES));
    const before = bytes.byteLength;

    const first = await extractPdf(bytes);
    assert.equal(bytes.byteLength, before, "the caller's buffer was detached");

    const second = await extractPdf(bytes);
    assert.equal(second.charCount, first.charCount, "a second extraction of the same bytes differed");
  });

  test("is deterministic", async () => {
    const bytes = new Uint8Array(buildPdf(KNOWN_GOOD_PAGES));
    const a = await extractPdf(bytes);
    const b = await extractPdf(bytes);
    assert.deepEqual(b.pages.map((p) => p.text), a.pages.map((p) => p.text));
  });

  test("reports a version, so stale rows can be found later", () => {
    assert.equal(typeof EXTRACTOR_VERSION, "number");
    assert.ok(EXTRACTOR_VERSION >= 1);
  });

  test("collects warnings rather than hiding them", async () => {
    const doc = await extractPdf(new Uint8Array(buildPdf(KNOWN_GOOD_PAGES)));
    assert.ok(Array.isArray(doc.warnings));
    // A clean document should be clean. If this starts failing, something is
    // wrong with the fixture or the extractor — which is the point.
    assert.deepEqual(doc.warnings, [], `a known-good document produced warnings: ${doc.warnings}`);
  });
});

describe("the fixture builder does not silently lose text", () => {
  /**
   * A property of the *helper*, asserted because its absence looked exactly
   * like a product bug.
   *
   * Text painted outside the page box is not extracted — correctly, since a
   * reader never sees it. So a fixture line wider than the page came back
   * truncated mid-word with no warning: a 96-character sentence extracted as 89
   * characters. Found while building a dense Q&A corpus, where it presented as
   * retrieval citing the right page for a sentence that was not in the
   * extracted text. Every assertion anywhere that names a phrase it expects on
   * a page depends on this.
   */
  const SENTENCE =
    "The Vendor shall not transfer City data outside the United States without prior written consent.";

  test("a line wider than the page survives extraction", async () => {
    assert.ok(SENTENCE.length > 88, "the fixture sentence is no longer long enough to test this");
    const extracted = await extractPdf(buildPdf([[SENTENCE]]));
    const text = extracted.pages[0]?.text ?? "";
    // Wrapped, so the words are preserved even though the line breaks move.
    assert.ok(
      text.replace(/\s+/g, " ").includes(SENTENCE),
      `the sentence did not survive extraction: ${JSON.stringify(text)}`,
    );
  });

  test("a run of capitals survives, though it is far wider than prose", async () => {
    // The case a character-count wrap gets wrong: `W` is 0.944em where
    // lowercase prose averages about 0.45em, so counting characters wraps this
    // too late and the tail falls off the page.
    const token = "W".repeat(200);
    const extracted = await extractPdf(buildPdf([[token]]));
    const text = (extracted.pages[0]?.text ?? "").replace(/\s+/g, "");
    assert.equal(text.length, 200, "a run of wide glyphs lost characters off the page edge");
  });

  test("a long single word is hard-broken rather than truncated", async () => {
    const token = "a".repeat(300);
    const extracted = await extractPdf(buildPdf([[token]]));
    const text = (extracted.pages[0]?.text ?? "").replace(/\s+/g, "");
    assert.equal(text.length, 300, "an unbreakable word lost characters");
  });

  test("short lines are not reflowed", async () => {
    // Wrapping must not disturb the documents every other suite asserts on.
    const lines = ["Heading", "A short body line.", "Another short line."];
    const extracted = await extractPdf(buildPdf([lines]));
    assert.equal(extracted.pages[0]?.text.split("\n").length, lines.length);
  });
});

describe("malformed input fails as a category", () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ["random bytes", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "unsupported_type"],
    ["an empty buffer", new Uint8Array(0), "unsupported_type"],
    ["a header and nothing else", new Uint8Array(Buffer.from("%PDF-1.7\n")), "unreadable"],
  ];

  for (const [label, bytes, expected] of cases) {
    test(`${label} -> ${expected}`, async () => {
      await assert.rejects(
        () => extractPdf(bytes),
        (error: unknown) => {
          assert.ok(error instanceof PdfExtractionError, `threw ${String(error)}`);
          assert.equal(error.code, expected);
          return true;
        },
      );
    });
  }

  test("a truncated document does not hang or return half a result", async () => {
    const full = buildPdf(KNOWN_GOOD_PAGES);
    const truncated = new Uint8Array(full.subarray(0, Math.floor(full.length / 2)));
    await assert.rejects(() => extractPdf(truncated), PdfExtractionError);
  });

  test("the error message carries no file path or library internals", async () => {
    await assert.rejects(
      () => extractPdf(new Uint8Array([0, 1, 2, 3, 4, 5])),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(!/\//.test(message), `message looks like a path: ${message}`);
        assert.ok(message.length < 120, "message is long enough to be a stack trace");
        return true;
      },
    );
  });
});

describe("classification", () => {
  test("a real document is ready", async () => {
    const doc = await extractPdf(new Uint8Array(buildPdf(KNOWN_GOOD_PAGES)));
    assert.equal(classify(doc).status, "ready");
  });

  test("an image-only document is no_text, not a failure", async () => {
    // The case OCR would solve and we are explicitly not solving. It must be
    // reported honestly rather than as an empty success or an error.
    // Page numbers, from 1 — see the note on buildPdf.
    const bytes = buildPdf(KNOWN_GOOD_PAGES, { imageOnlyPages: [1, 2, 3] });
    const doc = await extractPdf(new Uint8Array(bytes));
    const result = classify(doc);

    assert.equal(result.status, "no_text");
    assert.equal(result.pagesWithText, 0);
  });

  test("a long document with text on one page is partial_text", async () => {
    const pages: string[][] = [];
    for (let i = 0; i < 40; i += 1) pages.push([]);
    pages[0] = KNOWN_GOOD_PAGES[0]!;
    // Pages 2..40 blank; page 1 keeps its text.
    const imageOnly = Array.from({ length: 39 }, (_, i) => i + 2);

    const doc = await extractPdf(new Uint8Array(buildPdf(pages, { imageOnlyPages: imageOnly })));
    assert.equal(classify(doc).status, "partial_text");
  });

  test("a legitimate very short document is not rejected for low density", async () => {
    // The regression this heuristic was fixed for. Six words on one page is a
    // normal receipt, not a scan, and an earlier version called it partial_text.
    const doc = await extractPdf(new Uint8Array(buildPdf([["Invoice 4102. Paid in full."]])));
    const result = classify(doc);

    assert.equal(
      result.status,
      "ready",
      `a short but perfectly readable document was classified ${result.status}`,
    );
  });
});
