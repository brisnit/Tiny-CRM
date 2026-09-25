import "server-only";

import { db } from "@/lib/db";
import { LIMITS } from "@/lib/validation/limits";
import { requireDocumentIntelligence } from "@/lib/documents/gate";
import type { DocumentIngestionStatus } from "@/lib/enums";

/**
 * Finding the passages of one document that bear on a question.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it deliberately is not
 * ---------------------------------------------------------------------------
 *
 * Deterministic lexical retrieval over the chunks a document has already been
 * ingested into. No embeddings, no vector store, no second index, no model.
 * Same question and same corpus produce the same passages in the same order,
 * every run, on both engines.
 *
 * The Phase 3D probe established that the corpus is searchable by plain term
 * matching — 15 of 15 concepts found, with SQL agreeing with a literal
 * reference on every one. That was evidence about the *corpus*, not a choice of
 * runtime architecture: `ILIKE` is not used here. The matching happens in
 * application code because that is the only way to get exact word boundaries
 * and exact inverse document frequency, and those two things are what separate
 * a useful passage from an incidental substring.
 *
 * `API` is the case that settles it. `ILIKE '%api%'` also matches *rapid*,
 * *capital* and *therapies*. A retrieval layer that cannot tell those apart
 * hands a model three irrelevant passages and invites a confident wrong answer
 * with a page number attached to it.
 *
 * ---------------------------------------------------------------------------
 * Why the whole document is read rather than pre-filtered in SQL
 * ---------------------------------------------------------------------------
 *
 * One document's corpus is small and bounded: ingestion caps extracted text at
 * `maxChars`, so a document cannot exceed ~833 chunks, and the RFP this was
 * designed against has 20. Reading them costs one indexed query on
 * (workspaceId, fileAssetId, ordinal) and no text predicate at all.
 *
 * Reading all of them is also what makes the scoring honest: inverse document
 * frequency needs the document frequency of a term across the *whole* corpus.
 * Computing it over a pre-filtered candidate set would measure the filter
 * rather than the document.
 *
 * This is single-document retrieval. Searching across many documents is a
 * different problem with a different answer — that is where a trigram index or
 * a vector store would start to earn its place, and neither is needed here.
 *
 * ---------------------------------------------------------------------------
 * The trust boundary
 * ---------------------------------------------------------------------------
 *
 * The caller supplies a `fileAssetId` and a question. **Nothing else.** No
 * workspace, no project, no chunk id, no ordinal, no page. The workspace is
 * resolved from the file by `requireRecordAccess` in the caller (see the route),
 * and this module is handed the result. There is no argument here by which a
 * caller can widen scope.
 */

export type RetrievedPassage = {
  fileAssetId: string;
  fileName: string;
  /** Nullable: a FileAsset may hang off a contact, company, deal or opportunity. */
  projectId: string | null;
  projectName: string | null;
  ingestionId: string;
  chunkId: string;
  ordinal: number;
  /** The span of the *source* chunk. Unchanged by de-overlap — see below. */
  pageStart: number;
  pageEnd: number;
  /** De-overlapped: text repeated from the preceding passage is removed. */
  text: string;
  score: number;
  /** Which terms earned this passage its place. Makes a result auditable. */
  matchedTerms: string[];
};

export type RetrievalReason = "ok" | "no_terms" | "no_matches" | "not_ready";

export type RetrievalResult = {
  passages: RetrievedPassage[];
  reason: RetrievalReason;
  corpus: { chunks: number; pageCount: number | null; status: DocumentIngestionStatus | null };
};

/** Rows fetched for one document. Ingestion bounds this far below the ceiling. */
const MAX_CORPUS_CHUNKS = 400;
/** Scored passages retained before the budget is applied. */
const MAX_CANDIDATES = 50;
/** Hard ceiling on passages reaching the model. */
const MAX_CONTEXT_PASSAGES = 6;
/** Shortest token worth matching. Protects three-letter acronyms: API, SEO, CMS. */
const MIN_TOKEN_LENGTH = 3;
/** Content tokens taken from a question. */
const MAX_TERMS = 12;
/** Adjacent-token phrases taken from a question. */
const MAX_PHRASES = 6;
/** A phrase is worth this many single tokens. */
const PHRASE_WEIGHT = 2;

/**
 * Words carrying no retrieval signal. Deliberately short and explicit: an
 * aggressive list throws away terms that matter in procurement prose ("not to
 * exceed", "no later than"), and a question reduced to nothing must retrieve
 * nothing rather than everything.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how",
  "its", "may", "new", "now", "old", "see", "two", "who", "did", "yes", "his",
  "this", "that", "with", "from", "have", "what", "when", "where", "which",
  "will", "would", "there", "their", "been", "does", "into", "than", "them",
  "then", "they", "were", "about", "could", "should", "these", "those",
  "please", "tell", "show", "give", "does", "doing", "much", "many", "need",
]);

export type QueryTerms = { tokens: string[]; phrases: string[] };

/**
 * Turns a question into terms.
 *
 * A pure function, so it is unit-tested without a database. Phrases are only
 * formed from tokens the user wrote *adjacently*: "submission deadline" earns
 * the phrase bonus, "deadline for submission" does not, because they are not
 * the same claim about the document.
 */
export function extractTerms(question: string): QueryTerms {
  const raw = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

  const tokens: string[] = [];
  const positions: number[] = [];
  raw.forEach((word, index) => {
    if (word.length < MIN_TOKEN_LENGTH) return;
    if (STOPWORDS.has(word)) return;
    if (tokens.includes(word)) return;
    tokens.push(word);
    positions.push(index);
  });

  const phrases: string[] = [];
  for (let i = 0; i + 1 < tokens.length && phrases.length < MAX_PHRASES; i += 1) {
    // Adjacent in the original question, with nothing dropped between them.
    if (positions[i + 1]! - positions[i]! === 1) phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
  }

  return { tokens: tokens.slice(0, MAX_TERMS), phrases };
}

/** Escapes a term for use inside a regular expression. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A matcher for one term, anchored to word boundaries.
 *
 * `\b` is ASCII-only in JavaScript, so the boundaries are written out as
 * lookarounds over Unicode letters, digits and underscore. That is what stops
 * `API` matching *rapid* or *capital*, which is the difference between a
 * relevant passage and a plausible-looking wrong one.
 *
 * A phrase tolerates any whitespace between its words, because extraction
 * preserves the document's line breaks and "scope of work" is frequently split
 * across two lines.
 */
function matcherFor(term: string): RegExp {
  const body = term.includes(" ")
    ? term.split(/\s+/).map(escape).join("\\s+")
    : escape(term);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

function countMatches(haystack: string, matcher: RegExp): number {
  // A fresh lastIndex per call: the matcher is reused across chunks.
  matcher.lastIndex = 0;
  let n = 0;
  while (matcher.exec(haystack) !== null) n += 1;
  return n;
}

type ScoredChunk = {
  index: number;
  score: number;
  matchedTerms: string[];
  distinctMatched: number;
};

/**
 * Scores chunks against a question's terms.
 *
 * ```
 *   idf(t)   = ln(1 + N / (1 + df(t)))
 *   tf(t,c)  = occurrences of t in chunk c
 *   w(t)     = 2 for a phrase, 1 for a token
 *   raw(c)   = Σ  w(t) · idf(t) · (1 + ln(tf(t,c)))
 *   score(c) = raw(c) · (1 + distinctMatched(c) / totalTerms)
 * ```
 *
 * Inverse document frequency is what stops a broad term dominating: a word in
 * every chunk of twenty scores ~0.67, a word in one scores ~2.40. The coverage
 * multiplier prefers a chunk touching several *different* terms over one
 * repeating a single term, which is the difference between a passage that
 * answers the question and a passage that merely mentions a word from it.
 *
 * Exported for direct unit testing: the ordering properties are the ones that
 * matter and they should not require a database to assert.
 */
export function scoreChunks(texts: string[], terms: QueryTerms): ScoredChunk[] {
  const all = [
    ...terms.tokens.map((t) => ({ term: t, weight: 1 })),
    ...terms.phrases.map((t) => ({ term: t, weight: PHRASE_WEIGHT })),
  ];
  if (all.length === 0 || texts.length === 0) return [];

  const n = texts.length;
  // Occurrence matrix, computed once.
  const tf = all.map(({ term }) => {
    const matcher = matcherFor(term);
    return texts.map((text) => countMatches(text, matcher));
  });
  const df = tf.map((row) => row.filter((c) => c > 0).length);

  const scored: ScoredChunk[] = [];
  for (let c = 0; c < n; c += 1) {
    let raw = 0;
    const matched: string[] = [];
    for (let t = 0; t < all.length; t += 1) {
      const count = tf[t]![c]!;
      if (count === 0) continue;
      const idf = Math.log(1 + n / (1 + df[t]!));
      raw += all[t]!.weight * idf * (1 + Math.log(count));
      matched.push(all[t]!.term);
    }
    if (matched.length === 0) continue;
    const score = raw * (1 + matched.length / all.length);
    scored.push({
      index: c,
      // Rounded so ordering cannot turn on floating-point noise. The ordinal
      // tie-break below makes the comparator a total order regardless.
      score: Math.round(score * 1e6) / 1e6,
      matchedTerms: matched,
      distinctMatched: matched.length,
    });
  }
  return scored;
}

/**
 * Removes from `text` any leading paragraph that already appeared in `previous`.
 *
 * Chunking carries whole trailing paragraphs forward as overlap, so two
 * adjacent chunks share text by design. Sending it twice wastes the context
 * budget and makes one source look like two corroborating ones.
 *
 * The page span is **not** narrowed when text is removed. A passage's span
 * describes where its source chunk came from, and a citation that quietly
 * dropped a page because the quotation was trimmed would be a false citation.
 */
export function deOverlap(previous: string, text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  let drop = 0;
  while (drop < paragraphs.length - 1 && previous.includes(paragraphs[drop]!.trim())) drop += 1;
  return drop === 0 ? text : paragraphs.slice(drop).join("\n\n");
}

export async function retrievePassages(input: {
  fileAssetId: string;
  workspaceId: string;
  question: string;
}): Promise<RetrievalResult> {
  // The gate, inside the tenant context the caller has already earned. It
  // asserts a context rather than opening one — see documents/gate.ts for the
  // defect that rule exists to prevent a fourth of.
  await requireDocumentIntelligence(input.workspaceId);

  const rows = await db.documentChunk.findMany({
    // Both columns: `fileAssetId` is what the caller authorised, and naming the
    // workspace too keeps the query honest independently of row-level security.
    where: { fileAssetId: input.fileAssetId, workspaceId: input.workspaceId },
    orderBy: { ordinal: "asc" },
    take: MAX_CORPUS_CHUNKS,
    select: {
      id: true, ordinal: true, pageStart: true, pageEnd: true, text: true,
      ingestionId: true, fileAssetId: true, workspaceId: true,
      ingestion: {
        select: {
          status: true, pageCount: true,
          fileAsset: {
            select: { name: true, projectId: true, project: { select: { name: true } } },
          },
        },
      },
    },
  });

  const status = (rows[0]?.ingestion.status ?? null) as DocumentIngestionStatus | null;
  const pageCount = rows[0]?.ingestion.pageCount ?? null;

  // Only a completed extraction is evidence. A partial, empty, failed or
  // unsupported document contributes nothing rather than contributing a little.
  const ready = rows.filter((r) => r.ingestion.status === "ready");
  if (ready.length === 0) {
    return { passages: [], reason: "not_ready", corpus: { chunks: 0, pageCount, status } };
  }

  const corpus = { chunks: ready.length, pageCount, status };

  const terms = extractTerms(input.question);
  if (terms.tokens.length === 0) {
    // A question with no usable term retrieves nothing. It must never fall
    // through to "match everything", which would be the most expensive query in
    // the product and the least relevant answer.
    return { passages: [], reason: "no_terms", corpus };
  }

  const scored = scoreChunks(ready.map((r) => r.text), terms);
  if (scored.length === 0) return { passages: [], reason: "no_matches", corpus };

  // A total order: score, then breadth of match, then ordinal. Ordinal is
  // unique, so the comparator never falls through to input order.
  scored.sort((a, b) =>
    b.score - a.score ||
    b.distinctMatched - a.distinctMatched ||
    ready[a.index]!.ordinal - ready[b.index]!.ordinal);

  const budget = LIMITS.maxAiDocumentContextChars;
  const chosen: typeof scored = [];
  let used = 0;
  for (const candidate of scored.slice(0, MAX_CANDIDATES)) {
    if (chosen.length >= MAX_CONTEXT_PASSAGES) break;
    // Measured before de-overlap, which can only shrink the text.
    const size = ready[candidate.index]!.text.length;
    if (used + size > budget) continue;
    chosen.push(candidate);
    used += size;
  }

  // Emitted in document order so the model reads the document forwards, and so
  // de-overlap compares neighbours.
  chosen.sort((a, b) => ready[a.index]!.ordinal - ready[b.index]!.ordinal);

  const passages: RetrievedPassage[] = [];
  for (const candidate of chosen) {
    const row = ready[candidate.index]!;
    const previous = passages[passages.length - 1];
    const adjacent = previous && row.ordinal === previous.ordinal + 1;
    const text = adjacent ? deOverlap(previous.text, row.text) : row.text;

    passages.push({
      fileAssetId: row.fileAssetId,
      fileName: row.ingestion.fileAsset.name,
      projectId: row.ingestion.fileAsset.projectId,
      projectName: row.ingestion.fileAsset.project?.name ?? null,
      ingestionId: row.ingestionId,
      chunkId: row.id,
      ordinal: row.ordinal,
      pageStart: row.pageStart,
      pageEnd: row.pageEnd,
      text,
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
    });
  }

  return { passages, reason: "ok", corpus };
}
