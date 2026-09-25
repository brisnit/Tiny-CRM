import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { extractTerms, scoreChunks, deOverlap } from "../../src/lib/documents/retrieve";
import { buildCitations, formatPageRange, unsupportedAnswer } from "../../src/lib/ai/document-agent";
import { LIMITS } from "../../src/lib/validation/limits";

/**
 * Retrieval properties, tested as properties.
 *
 * Deliberately not coupled to the one RFP this was designed against: every
 * assertion below is about the algorithm, on synthetic text whose contents are
 * visible in the test. A suite that only proved "this document works" would
 * pass while the mechanism was wrong for the next document.
 */

describe("term extraction", () => {
  test("keeps content words and drops stopwords and short tokens", () => {
    const { tokens } = extractTerms("What is the submission deadline for this RFP?");
    assert.ok(tokens.includes("submission"));
    assert.ok(tokens.includes("deadline"));
    assert.ok(!tokens.includes("the"), "a stopword survived");
    assert.ok(!tokens.includes("is"), "a two-letter token survived");
  });

  test("keeps three-letter acronyms — they are the point", () => {
    // MIN_TOKEN_LENGTH is 3 precisely so API, SEO, CMS and ADA survive.
    for (const q of ["Is an API required?", "What about SEO?", "Which CMS?", "ADA compliance?"]) {
      const { tokens } = extractTerms(q);
      assert.equal(tokens.length >= 1, true, `${q} produced no tokens`);
    }
    assert.ok(extractTerms("Is an API required?").tokens.includes("api"));
  });

  test("forms a phrase only from adjacent words the user actually wrote", () => {
    assert.deepEqual(extractTerms("submission deadline").phrases, ["submission deadline"]);
    // Separated by a dropped stopword: not the same claim, so not a phrase.
    assert.deepEqual(extractTerms("deadline for submission").phrases, []);
  });

  test("is deterministic and deduplicates", () => {
    const a = extractTerms("insurance insurance INSURANCE limits");
    const b = extractTerms("insurance insurance INSURANCE limits");
    assert.deepEqual(a, b);
    assert.equal(a.tokens.filter((t) => t === "insurance").length, 1);
  });

  test("a question of nothing but stopwords yields no terms", () => {
    // This is what makes "retrieve nothing" possible instead of "match everything".
    assert.deepEqual(extractTerms("what about the, and for this?").tokens, []);
  });
});

describe("word boundaries — the false-positive class", () => {
  const texts = [
    "The vendor shall expose a documented API for integrations.",   // 0 real
    "Work shall proceed rapidly to meet the capital schedule.",     // 1 rapid/capital
    "New therapies are out of scope for this engagement.",          // 2 therapies
  ];

  test("API matches API and not rapid, capital or therapies", () => {
    const scored = scoreChunks(texts, { tokens: ["api"], phrases: [] });
    assert.deepEqual(scored.map((s) => s.index), [0],
      "a substring match leaked in — rapid/capital/therapies contain 'api'");
  });

  test("a bare substring search would have matched all three", () => {
    // The control: proves the fixture really does contain the trap, so the
    // assertion above is testing the boundary rather than a weak fixture.
    const naive = texts.filter((t) => t.toLowerCase().includes("api"));
    assert.equal(naive.length, 3, "the fixture no longer exercises the false positive");
  });

  test("matching is case-insensitive", () => {
    assert.equal(scoreChunks(["An API requirement"], { tokens: ["api"], phrases: [] }).length, 1);
    assert.equal(scoreChunks(["an api requirement"], { tokens: ["API"], phrases: [] }).length, 1);
  });

  test("punctuation does not break a boundary", () => {
    const scored = scoreChunks(["Provide an (API), documented."], { tokens: ["api"], phrases: [] });
    assert.equal(scored.length, 1);
  });
});

describe("phrases tolerate the document's line breaks", () => {
  test("a phrase split across a newline still matches", () => {
    const texts = ["Section 2. The scope\nof work includes discovery."];
    const scored = scoreChunks(texts, { tokens: [], phrases: ["scope of work"] });
    assert.equal(scored.length, 1, "a phrase broken by a newline was missed");
  });

  test("a phrase split across a blank line still matches", () => {
    const texts = ["…the scope\n\nof work…"];
    assert.equal(scoreChunks(texts, { tokens: [], phrases: ["scope of work"] }).length, 1);
  });

  test("a phrase does not match when the words are not consecutive", () => {
    const texts = ["The scope of the work of the vendor."];
    assert.equal(scoreChunks(texts, { tokens: [], phrases: ["scope of work"] }).length, 0);
  });
});

describe("scoring", () => {
  test("a rarer term outranks a universal one", () => {
    const texts = [
      "insurance insurance insurance",           // 0: common term, thrice
      "insurance and one indemnification",       // 1: common + rare
    ];
    const scored = scoreChunks(texts, { tokens: ["insurance", "indemnification"], phrases: [] });
    scored.sort((a, b) => b.score - a.score);
    assert.equal(scored[0]!.index, 1,
      "term frequency beat inverse document frequency and breadth of match");
  });

  test("a phrase match outweighs the same words as loose tokens", () => {
    const withPhrase = scoreChunks(["the scope of work is broad"],
      { tokens: ["scope", "work"], phrases: ["scope of work"] })[0]!;
    const withoutPhrase = scoreChunks(["the scope of work is broad"],
      { tokens: ["scope", "work"], phrases: [] })[0]!;
    assert.ok(withPhrase.score > withoutPhrase.score, "the phrase weighting did nothing");
  });

  test("breadth of match is rewarded over repetition", () => {
    const texts = [
      "deadline deadline deadline deadline",     // 0: one term, four times
      "deadline submission",                     // 1: two different terms
    ];
    const scored = scoreChunks(texts, { tokens: ["deadline", "submission"], phrases: [] });
    const byIndex = new Map(scored.map((s) => [s.index, s]));
    assert.equal(byIndex.get(1)!.distinctMatched, 2);
    assert.equal(byIndex.get(0)!.distinctMatched, 1);
  });

  test("a chunk matching nothing is not a candidate", () => {
    const scored = scoreChunks(["nothing relevant here"], { tokens: ["insurance"], phrases: [] });
    assert.deepEqual(scored, []);
  });

  test("no terms means no candidates, never all of them", () => {
    assert.deepEqual(scoreChunks(["a", "b", "c"], { tokens: [], phrases: [] }), []);
  });

  test("identical input produces byte-identical output", () => {
    const texts = ["alpha beta", "beta gamma", "gamma alpha beta"];
    const terms = { tokens: ["alpha", "beta", "gamma"], phrases: [] };
    assert.deepEqual(
      JSON.stringify(scoreChunks(texts, terms)),
      JSON.stringify(scoreChunks(texts, terms)),
    );
  });

  test("scores are rounded, so ordering cannot turn on float noise", () => {
    for (const s of scoreChunks(["alpha beta"], { tokens: ["alpha"], phrases: [] })) {
      assert.equal(s.score, Math.round(s.score * 1e6) / 1e6);
    }
  });
});

describe("de-overlap", () => {
  test("removes a leading paragraph the predecessor already carried", () => {
    const previous = "First para.\n\nShared para.";
    const next = "Shared para.\n\nNew para.";
    assert.equal(deOverlap(previous, next), "New para.");
  });

  test("removes several repeated leading paragraphs", () => {
    const previous = "A.\n\nB.\n\nC.";
    const next = "B.\n\nC.\n\nD.";
    assert.equal(deOverlap(previous, next), "D.");
  });

  test("leaves unrelated text alone", () => {
    const next = "Totally new.\n\nAlso new.";
    assert.equal(deOverlap("Nothing in common.", next), next);
  });

  test("never removes the entire passage", () => {
    // A chunk wholly contained in its predecessor must still yield something,
    // or a selected passage would arrive empty.
    const previous = "A.\n\nB.";
    assert.notEqual(deOverlap(previous, "A.\n\nB.").trim(), "");
  });
});

describe("citations are built from stored provenance", () => {
  const passage = (over: Partial<Record<string, unknown>> = {}) => ({
    fileAssetId: "file_1", fileName: "RFP.pdf", projectId: null, projectName: null,
    ingestionId: "ing_1", chunkId: "c1", ordinal: 0, pageStart: 7, pageEnd: 7,
    text: "…", score: 1, matchedTerms: ["deadline"], ...over,
  }) as Parameters<typeof buildCitations>[0][number];

  test("a single page reads p. N", () => {
    assert.equal(formatPageRange(7, 7), "p. 7");
  });

  test("a span reads pp. N–M with an en dash", () => {
    assert.equal(formatPageRange(12, 14), "pp. 12–14");
  });

  test("the block names the file and the pages", () => {
    const out = buildCitations([passage()]);
    assert.match(out, /Sources/);
    assert.match(out, /RFP\.pdf — p\. 7/);
  });

  test("two passages on the same span cite once", () => {
    const out = buildCitations([passage({ chunkId: "c1" }), passage({ chunkId: "c2" })]);
    assert.equal((out.match(/RFP\.pdf/g) ?? []).length, 1, "a duplicate citation was emitted");
  });

  test("distinct spans each cite", () => {
    const out = buildCitations([passage(), passage({ pageStart: 12, pageEnd: 14 })]);
    assert.match(out, /p\. 7/);
    assert.match(out, /pp\. 12–14/);
  });

  test("no passages means no sources block", () => {
    assert.equal(buildCitations([]), "");
  });
});

describe("the unsupported answer", () => {
  const result = (over = {}) => ({
    passages: [], reason: "no_matches" as const,
    corpus: { chunks: 20, pageCount: 25, status: "ready" as const }, ...over,
  });

  test("names the document and what was searched", () => {
    const out = unsupportedAnswer("RFP.pdf", result());
    assert.match(out, /RFP\.pdf/);
    assert.match(out, /20 extracted passages/);
    assert.match(out, /25 pages/);
  });

  test("is deterministic", () => {
    assert.equal(unsupportedAnswer("RFP.pdf", result()), unsupportedAnswer("RFP.pdf", result()));
  });

  test("distinguishes an unread document from an unanswered question", () => {
    const notReady = unsupportedAnswer("RFP.pdf", result({ reason: "not_ready" as const }));
    assert.match(notReady, /haven't been able to read/);
    assert.notEqual(notReady, unsupportedAnswer("RFP.pdf", result()));
  });

  test("distinguishes an unusable question", () => {
    assert.match(unsupportedAnswer("RFP.pdf", result({ reason: "no_terms" as const })),
      /couldn't tell what to look for/);
  });

  test("singularises one passage and one page", () => {
    const out = unsupportedAnswer("RFP.pdf", result({ corpus: { chunks: 1, pageCount: 1, status: "ready" as const } }));
    assert.match(out, /1 extracted passage\b/);
    assert.match(out, /1 page\b/);
  });
});

describe("the declared budget", () => {
  test("document context is below the general AI context ceiling", () => {
    // Six passages at the chunker's ~2,500-char target would exceed
    // maxAiContextChars on their own; the document budget must leave room.
    assert.ok(LIMITS.maxAiDocumentContextChars < LIMITS.maxAiContextChars);
    assert.equal(LIMITS.maxAiDocumentContextChars, 12_000);
  });
});
