import "server-only";

import { SYSTEM_PROMPTS, withContext } from "@/lib/ai/prompts";
import { getProviderForWorkspace, isModelBacked } from "@/lib/ai/provider";
import type { AiProvider } from "@/lib/ai/provider";
import { log } from "@/lib/logger";
import type { RetrievalResult, RetrievedPassage } from "@/lib/documents/retrieve";

/**
 * Answering a question about one document, from that document only.
 *
 * ---------------------------------------------------------------------------
 * The refusal is structural, not prompted
 * ---------------------------------------------------------------------------
 *
 * When retrieval selects no passages, **no provider is resolved and no provider
 * is called**. `unsupportedAnswer()` is returned directly. A model that is never
 * asked cannot answer from general knowledge, cannot hallucinate a deadline, and
 * cannot attach a page number to something the document does not contain.
 *
 * This is the difference between a control and a mitigation. The system prompt
 * also tells the model to refuse when the evidence is thin — that covers the
 * case where passages exist but do not settle the question. It is not what
 * protects the empty case, because an instruction is advice and a missing call
 * is a guarantee.
 *
 * ---------------------------------------------------------------------------
 * Citations are ours
 * ---------------------------------------------------------------------------
 *
 * Page numbers come from `DocumentChunk.pageStart/pageEnd`, read from the rows
 * retrieval selected. The model is never given them and is explicitly told not
 * to produce any. A page it invented would be indistinguishable, to a reader,
 * from one we verified — and the entire value of a citation is that it can be
 * checked.
 */

/** `p. 7` for a single page, `pp. 12–14` for a span. En dash, as in prose. */
export function formatPageRange(pageStart: number, pageEnd: number): string {
  return pageStart === pageEnd ? `p. ${pageStart}` : `pp. ${pageStart}–${pageEnd}`;
}

/**
 * The sources block, built from stored provenance.
 *
 * One line per distinct page span, in document order, deduplicated: two
 * adjacent passages covering the same span are one citation, not two.
 */
export function buildCitations(passages: readonly RetrievedPassage[]): string {
  if (passages.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of passages) {
    const key = `${p.fileAssetId}:${p.pageStart}-${p.pageEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`• ${p.fileName} — ${formatPageRange(p.pageStart, p.pageEnd)}`);
  }
  return `\n\nSources\n${lines.join("\n")}`;
}

/**
 * What the user is told when the document does not support an answer.
 *
 * Names the document and the corpus that was searched, so the answer is a
 * statement about the evidence rather than a shrug. Deterministic: the same
 * inputs always produce the same sentence, which is what makes it testable.
 */
export function unsupportedAnswer(fileName: string, result: RetrievalResult): string {
  const { reason, corpus } = result;

  if (reason === "not_ready") {
    return `I haven't been able to read ${fileName} yet, so I can't answer questions about it.`;
  }
  if (reason === "no_terms") {
    return `I couldn't tell what to look for in ${fileName}. Try naming a specific thing — a deadline, a requirement, a section.`;
  }
  const pages = corpus.pageCount ? ` across ${corpus.pageCount} page${corpus.pageCount === 1 ? "" : "s"}` : "";
  return `I couldn't find anything about that in ${fileName}. I searched all ${corpus.chunks} extracted passage${corpus.chunks === 1 ? "" : "s"}${pages}.`;
}

/**
 * What the user is told when no model can answer from a source.
 *
 * Deliberately says nothing about the document's contents. The evidence was
 * found — four passages, cited pages and all — and the failure is entirely on
 * our side, so implying the document is at fault would be a lie in the most
 * misleading possible direction.
 *
 * It also says nothing about *why*: an end user cannot act on a missing API key
 * or a workspace privacy mode, and naming either would leak configuration.
 */
export function providerUnavailableAnswer(fileName: string): string {
  return `I can't answer questions about ${fileName} right now — Tiny AI has no model available to read it with. Nothing is wrong with the document.`;
}

/**
 * Resolves the provider for a workspace and says whether it can do this job.
 *
 * Document Q&A needs a model. The built-in engine is a deterministic keyword
 * engine over CRM shapes — it has no notion of answering from supplied source
 * text, and handed a document it produces confident, unrelated prose. The
 * caller must refuse rather than let that happen, because the route then
 * attaches real page citations to whatever comes back, and a wrong answer
 * wearing accurate provenance is worse than either failure alone.
 */
export async function resolveDocumentProvider(
  workspaceId: string,
): Promise<{ provider: AiProvider; capable: boolean }> {
  const provider = await getProviderForWorkspace(workspaceId);
  return { provider, capable: isModelBacked(provider) };
}

/** The context block. Provenance is included as a label the model may read but not cite. */
function contextFor(passages: readonly RetrievedPassage[]): string {
  return passages
    .map((p) => `[passage ${p.ordinal}]\n${p.text}`)
    .join("\n\n---\n\n");
}

export type DocumentAnswerRequest = {
  workspaceId: string;
  fileName: string;
  question: string;
  result: RetrievalResult;
  /**
   * The provider the caller already resolved and checked. Passed in rather than
   * resolved again so there is exactly one resolution per request, and so the
   * capability check cannot be skipped by calling this directly.
   */
  provider: AiProvider;
};

/**
 * Streams an answer grounded in the retrieved passages.
 *
 * **Only called when `result.passages` is non-empty.** The caller checks that
 * and returns `unsupportedAnswer()` itself; this function asserts it rather than
 * tolerating it, so the invariant cannot erode into "usually".
 */
export async function* answerFromDocument(
  request: DocumentAnswerRequest,
): AsyncIterable<string> {
  const { passages } = request.result;
  if (passages.length === 0) {
    throw new Error("answerFromDocument called with no passages — the caller must refuse instead");
  }
  const { provider } = request;
  if (!isModelBacked(provider)) {
    // Asserted rather than tolerated, for the same reason as the line above:
    // an invariant that is merely usually true is not one.
    throw new Error(
      "answerFromDocument called with a provider that is not model-backed — the caller must refuse instead",
    );
  }

  // Counts and page spans only. Never passage text — document contents are
  // CONFIDENTIAL (docs/DATA-CLASSIFICATION.md) and are not logged.
  log.info("document question answered", {
    passageCount: passages.length,
    chars: passages.reduce((n, p) => n + p.text.length, 0),
    pages: passages.map((p) => `${p.pageStart}-${p.pageEnd}`).join(","),
    provider: provider.id,
  });

  for await (const chunk of provider.stream({
    purpose: "agent",
    system: SYSTEM_PROMPTS.documentQa,
    effort: "medium",
    maxTokens: 1200,
    // The same untrusted-data boundary every other context uses: document text
    // goes inside <crm_context>, and stripDelimiters removes anything in it
    // that could forge a closing tag.
    messages: [{ role: "user", content: withContext(request.question, contextFor(passages)) }],
  })) {
    yield chunk;
  }

  // Appended after the model's output, from our own rows.
  yield buildCitations(passages);
}
