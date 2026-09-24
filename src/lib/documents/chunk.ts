import "server-only";

import type { ExtractedDocument } from "@/lib/documents/extract";

/**
 * Splitting a document into retrievable pieces.
 *
 * Nothing is embedded yet, and this deliberately commits to no provider: the
 * output is plain text with the pages it came from. If we later choose a vector
 * store, an embedding column is added beside these rows; if we choose keyword
 * retrieval, these rows are what is indexed. Neither decision is made here.
 *
 * ---------------------------------------------------------------------------
 * What it optimises for
 * ---------------------------------------------------------------------------
 *
 * Source-grounded answers. The reason to chunk at all is so an answer can cite
 * "page 14" and a person can go and check. Three rules follow from that:
 *
 * **Page provenance is never approximated.** A chunk records the exact span it
 * came from, and it earns that span by only ever containing text from those
 * pages. Overlap is carried as whole paragraphs, so the pages a chunk claims
 * are the pages its text is actually on — not the pages it mostly came from.
 *
 * **Distant pages are never combined.** A chunk covers at most
 * `MAX_PAGE_SPAN` *consecutive* pages. Stitching page 3 to page 40 to reach a
 * size target produces a passage that reads as continuous prose and is not,
 * which is precisely how a grounded answer becomes a confident fabrication.
 * Short pages produce short chunks, and that is the correct outcome.
 *
 * **The output is deterministic.** Same bytes in, same chunks out, same
 * ordinals — no randomness, no clock, no model. That is what makes
 * reprocessing idempotent: re-running over an unchanged document rewrites
 * ordinal 0..n-1 with identical content rather than producing a second,
 * subtly different set.
 */

export type Chunk = {
  ordinal: number;
  text: string;
  pageStart: number;
  pageEnd: number;
  charCount: number;
  tokenEstimate: number;
};

/** Comfortable for retrieval: large enough to hold an argument, small enough to be specific. */
const TARGET_CHARS = 2_400;
/** A single paragraph longer than this is split rather than allowed to dominate a chunk. */
const MAX_CHARS = 3_200;
/** How much trailing context is repeated into the next chunk, as whole segments. */
const OVERLAP_CHARS = 500;
/**
 * Roughly how much text one segment holds.
 *
 * Segments are the unit everything else is built from: chunks are whole
 * segments, and overlap is whole segments. They therefore have to be
 * meaningfully smaller than a chunk, or no overlap can ever fit inside the
 * budget — which is exactly what happened before this constant existed. Pages
 * extracted from a PDF frequently contain no blank lines at all, so splitting
 * on paragraph breaks alone produced one segment per page, every segment far
 * larger than the overlap budget, and silently zero overlap everywhere.
 */
const SEGMENT_TARGET_CHARS = 400;
/** A single segment larger than this is never carried forward as overlap. */
const MAX_OVERLAP_SEGMENT_CHARS = 900;
/** A chunk may cover at most this many consecutive pages. */
const MAX_PAGE_SPAN = 3;
/** Shorter than this and a "paragraph" is a page number or a stray header. */
const MIN_SEGMENT_CHARS = 2;

/** Roughly four characters per token. Provider-neutral and deliberately coarse. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type Segment = { page: number; text: string };

export function chunkDocument(doc: ExtractedDocument): Chunk[] {
  const segments = toSegments(doc);
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: Segment[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(materialise(current, chunks.length));
    // Carry whole trailing paragraphs into the next chunk, newest first, until
    // the overlap budget is spent. Whole paragraphs rather than a character
    // slice: a chunk must not claim a page it only half-quotes, and a sentence
    // cut in the middle is worse context than no context.
    const carried: Segment[] = [];
    let budget = OVERLAP_CHARS;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const segment = current[i]!;
      if (segment.text.length > budget) break;
      carried.unshift(segment);
      budget -= segment.text.length;
    }
    // If the trailing segment alone overran the budget, carry it anyway —
    // within reason. Some overlap is the whole point, and a chunk boundary with
    // none is the case this is here to avoid. A segment larger than
    // MAX_OVERLAP_SEGMENT_CHARS is left behind: repeating that much text costs
    // more than the continuity is worth.
    const tail = current[current.length - 1];
    if (carried.length === 0 && current.length > 1 && tail && tail.text.length <= MAX_OVERLAP_SEGMENT_CHARS) {
      carried.push(tail);
    }
    // Never carry the entire chunk forward: that makes no progress and, with a
    // document of one short paragraph per page, loops.
    current = carried.length === current.length ? [] : carried;
  };

  for (const segment of segments) {
    for (const piece of splitLongSegment(segment)) {
      const wouldSpan = current.length > 0 && piece.page - current[0]!.page + 1 > MAX_PAGE_SPAN;
      const nonConsecutive =
        current.length > 0 && piece.page - current[current.length - 1]!.page > 1;
      const wouldOverflow = current.length > 0 && lengthOf(current) + piece.text.length > MAX_CHARS;

      if (wouldSpan || nonConsecutive || wouldOverflow) {
        flush();
        // A page gap is a hard boundary: overlap carried across it would make a
        // chunk claim pages whose text it does not contain.
        if (nonConsecutive) current = [];
      }

      current.push(piece);

      if (lengthOf(current) >= TARGET_CHARS) flush();
    }
  }

  if (current.length > 0) chunks.push(materialise(current, chunks.length));

  // The final flush can leave a chunk that is nothing but carried overlap —
  // every one of its paragraphs already appeared, in order, in its predecessor.
  // That is duplication with no new content, so it is dropped and the ordinals
  // stay contiguous.
  const last = chunks[chunks.length - 1];
  const previous = chunks[chunks.length - 2];
  if (last && previous && previous.text.endsWith(last.text)) chunks.pop();

  return chunks;
}

/**
 * Breaks each page into segments of roughly `SEGMENT_TARGET_CHARS`.
 *
 * Blank lines are respected as hard boundaries where a document has them, and
 * single line breaks are used where it does not — which is the common case, as
 * PDF text extraction rarely preserves paragraph spacing. Accumulating lines up
 * to a target rather than emitting one segment per line keeps segments close to
 * a natural unit of meaning without depending on the document's typography.
 *
 * A segment never spans two pages, so page provenance is exact by construction.
 */
function toSegments(doc: ExtractedDocument): Segment[] {
  const segments: Segment[] = [];

  for (const page of doc.pages) {
    if (page.charCount === 0) continue;

    for (const block of page.text.split(/\n{2,}/)) {
      let buffer: string[] = [];
      let length = 0;

      const emit = () => {
        const text = buffer.join("\n").trim();
        buffer = [];
        length = 0;
        if (text.length >= MIN_SEGMENT_CHARS) segments.push({ page: page.pageNumber, text });
      };

      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        buffer.push(trimmed);
        length += trimmed.length + 1;
        if (length >= SEGMENT_TARGET_CHARS) emit();
      }
      emit();
    }
  }

  return segments;
}

/**
 * Breaks a paragraph longer than one chunk into pieces, on sentence
 * boundaries where there are any and on whitespace otherwise.
 *
 * Stays on one page by construction — a paragraph belongs to a page — so this
 * cannot widen a chunk's provenance.
 */
function splitLongSegment(segment: Segment): Segment[] {
  if (segment.text.length <= MAX_CHARS) return [segment];

  const sentences = segment.text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [segment.text];
  const pieces: Segment[] = [];
  let buffer = "";

  const push = () => {
    const text = buffer.trim();
    if (text.length > 0) pieces.push({ page: segment.page, text });
    buffer = "";
  };

  for (const sentence of sentences) {
    // A single "sentence" can still exceed the ceiling — a table with no
    // punctuation, for instance. Hard-split it rather than emit an oversized
    // chunk.
    if (sentence.length > MAX_CHARS) {
      push();
      for (let i = 0; i < sentence.length; i += MAX_CHARS) {
        pieces.push({ page: segment.page, text: sentence.slice(i, i + MAX_CHARS).trim() });
      }
      continue;
    }
    if (buffer.length + sentence.length > MAX_CHARS) push();
    buffer += sentence;
  }
  push();

  return pieces.filter((p) => p.text.length >= MIN_SEGMENT_CHARS);
}

function lengthOf(segments: Segment[]): number {
  // +2 per join for the blank line between paragraphs.
  return segments.reduce((sum, s) => sum + s.text.length, 0) + Math.max(0, segments.length - 1) * 2;
}

function materialise(segments: Segment[], ordinal: number): Chunk {
  const text = segments.map((s) => s.text).join("\n\n");
  const pages = segments.map((s) => s.page);
  return {
    ordinal,
    text,
    pageStart: Math.min(...pages),
    pageEnd: Math.max(...pages),
    charCount: text.length,
    tokenEstimate: estimateTokens(text),
  };
}
