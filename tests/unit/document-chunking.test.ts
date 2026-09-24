import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildPdf, KNOWN_GOOD_PAGES } from "../helpers/pdf-fixture";
import { extractPdf, type ExtractedDocument } from "../../src/lib/documents/extract";
import { chunkDocument, estimateTokens } from "../../src/lib/documents/chunk";

/**
 * Splitting a document for retrieval.
 *
 * The properties that matter are structural, and they are the ones asserted
 * here: provenance is exact, distant pages are never welded together, ordinals
 * are contiguous, and the same bytes always produce the same chunks. Those are
 * what make a cited answer checkable and a reprocess idempotent.
 */

async function chunksOf(pages: string[][]) {
  const doc = await extractPdf(new Uint8Array(buildPdf(pages)));
  return { doc, chunks: chunkDocument(doc) };
}

/** A synthetic document with enough prose to force many chunks. */
function longDocument(pageCount: number): string[][] {
  const pages: string[][] = [];
  for (let p = 1; p <= pageCount; p += 1) {
    const lines = [`Section ${p}.0 - Requirements`];
    for (let i = 0; i < 12; i += 1) {
      lines.push(
        `Page ${p} paragraph ${i}: the contractor shall provide services described herein ` +
          `in accordance with the schedule and the terms set out in this section.`,
      );
    }
    pages.push(lines);
  }
  return pages;
}

describe("chunkDocument", () => {
  test("produces contiguous ordinals from zero", async () => {
    const { chunks } = await chunksOf(longDocument(12));
    assert.ok(chunks.length > 1, "a twelve-page document produced one chunk");
    assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
  });

  test("is deterministic", async () => {
    const doc = await extractPdf(new Uint8Array(buildPdf(longDocument(8))));
    const a = chunkDocument(doc);
    const b = chunkDocument(doc);
    assert.deepEqual(b, a, "two runs over the same document differed");
  });

  test("every chunk's text really is on the pages it claims", async () => {
    // The provenance claim, checked rather than trusted. Each chunk is built
    // from whole paragraphs, so every paragraph in a chunk must appear on a
    // page inside its declared span.
    const { doc, chunks } = await chunksOf(longDocument(10));

    for (const chunk of chunks) {
      const span = doc.pages.filter(
        (p) => p.pageNumber >= chunk.pageStart && p.pageNumber <= chunk.pageEnd,
      );
      const spanText = span.map((p) => p.text).join("\n");

      for (const paragraph of chunk.text.split("\n\n")) {
        assert.ok(
          spanText.includes(paragraph),
          `a chunk claiming pages ${chunk.pageStart}-${chunk.pageEnd} contains text ` +
            `that is not on those pages: ${paragraph.slice(0, 60)}…`,
        );
      }
    }
  });

  test("never welds distant pages together", async () => {
    const { chunks } = await chunksOf(longDocument(20));
    for (const chunk of chunks) {
      assert.ok(chunk.pageEnd >= chunk.pageStart, "a chunk has an inverted page span");
      assert.ok(
        chunk.pageEnd - chunk.pageStart <= 2,
        `a chunk spans pages ${chunk.pageStart}-${chunk.pageEnd}; distant pages must not be combined`,
      );
    }
  });

  test("a page gap is a hard boundary", async () => {
    // Pages 1 and 5 have content, 2-4 are blank. Nothing may produce a chunk
    // that claims to span them: the text either side is unrelated.
    const pages: string[][] = [
      ["Page one content about the scope of work and its requirements."],
      [], [], [],
      ["Page five content about pricing, which has nothing to do with scope."],
    ];
    const { chunks } = await chunksOf(pages);

    for (const chunk of chunks) {
      assert.ok(
        chunk.pageEnd - chunk.pageStart <= 2,
        `a chunk bridged a page gap: ${chunk.pageStart}-${chunk.pageEnd}`,
      );
    }
    // And the two real pages must not have been merged into one passage.
    const bridging = chunks.filter((c) => c.text.includes("scope of work") && c.text.includes("pricing"));
    assert.deepEqual(bridging, [], "page 1 and page 5 were joined into a single chunk");
  });

  test("consecutive chunks overlap, but do not merely repeat each other", async () => {
    const { doc, chunks } = await chunksOf(longDocument(10));
    assert.ok(chunks.length >= 3, "not enough chunks to observe overlap");

    let overlapping = 0;
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]!;
      const current = chunks[i]!;
      assert.notEqual(current.text, previous.text, "a chunk is an exact duplicate of its predecessor");

      const firstParagraph = current.text.split("\n\n")[0]!;
      if (previous.text.includes(firstParagraph)) overlapping += 1;
    }

    assert.ok(overlapping > 0, "no chunk carried any context from its predecessor");

    // Duplication has to stay bounded, or retrieval pays for the same text many
    // times over. The ratio is what is stored against what the document holds:
    // above 1 means overlap exists, and the ceiling is what keeps it modest.
    const stored = chunks.reduce((sum, c) => sum + c.charCount, 0);
    const ratio = stored / doc.charCount;

    assert.ok(ratio > 1, `no overlap at all: stored ${stored} of ${doc.charCount} characters`);
    assert.ok(
      ratio < 1.35,
      `chunk overlap duplicates too much text: ${ratio.toFixed(2)}x the document`,
    );
  });

  test("a document with no text produces no chunks", async () => {
    const doc: ExtractedDocument = { pageCount: 2, pages: [], charCount: 0, warnings: [] };
    assert.deepEqual(chunkDocument(doc), []);
  });

  test("a very short document produces one chunk on one page", async () => {
    const { chunks } = await chunksOf([["Invoice 4102. Paid in full."]]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.pageStart, 1);
    assert.equal(chunks[0]!.pageEnd, 1);
  });

  test("records a token estimate that tracks length", async () => {
    const { chunks } = await chunksOf(KNOWN_GOOD_PAGES);
    for (const chunk of chunks) {
      assert.equal(chunk.tokenEstimate, estimateTokens(chunk.text));
      assert.equal(chunk.charCount, chunk.text.length);
      assert.ok(chunk.tokenEstimate > 0);
    }
  });
});
