import "server-only";

import { MAX_PROMPT_CHARS } from "@/lib/ai/cost";
import { log } from "@/lib/logger";
import type { AiMessage } from "@/lib/ai/provider";

/**
 * The input half of the cost bound.
 *
 * `max_tokens` caps what a model writes. Nothing capped what it was asked to
 * read, and the agent path could assemble 42,000 characters — a 14,000-char
 * context, six prior turns of up to 4,000 each, and a 4,000-char question — for
 * every request. Input is billed, so that was the larger half of the bill and
 * the unbounded one.
 *
 * Enforcement lives in two places on purpose, each where truncation is safe:
 *
 *   - **Context assembly** (`fitContext`, called by `withContext`) trims the
 *     context payload. It has to happen there because the payload sits inside
 *     `<crm_context>` delimiters that the prompt-injection defence depends on;
 *     a blind tail-truncation could remove a closing tag and make retrieved
 *     records read as instructions.
 *   - **The provider** (`fitMessages`) drops whole messages, oldest history
 *     first. Whole-message granularity cannot corrupt a delimiter, and sitting
 *     at the provider means a new call site inherits the bound instead of having
 *     to remember it.
 *
 * Neither path ever throws. Exceeding a cost budget is not a reason to fail a
 * request a user is waiting on; it is a reason to send less.
 */

/** Characters reserved for the system prompt and delimiter scaffolding. */
const SCAFFOLD_RESERVE = 1_200;

/**
 * The largest context payload that still leaves room for the question and the
 * scaffolding around it.
 */
export function contextBudgetFor(questionChars: number): number {
  return Math.max(0, MAX_PROMPT_CHARS - SCAFFOLD_RESERVE - questionChars);
}

/**
 * Trims a context payload to its budget on a paragraph boundary where possible.
 *
 * A marker is appended so the model is told the context is partial rather than
 * being left to infer completeness from a sentence that stops mid-word.
 */
export function fitContext(context: string, questionChars: number): string {
  const budget = contextBudgetFor(questionChars);
  if (context.length <= budget) return context;

  const MARKER = "\n\n[Context truncated to fit the request budget.]";
  const room = Math.max(0, budget - MARKER.length);
  let kept = context.slice(0, room);

  // Prefer a paragraph break, then a line break, so a record is not cut in
  // half. Only accept one in the last fifth, otherwise too much is discarded.
  const floor = Math.floor(room * 0.8);
  const breakAt = Math.max(kept.lastIndexOf("\n\n"), kept.lastIndexOf("\n"));
  if (breakAt > floor) kept = kept.slice(0, breakAt);

  log.info("ai context truncated", {
    // Lengths only. Never the text: src/lib/ai/privacy.ts forbids CRM content
    // in logs, and a truncation event is not an exception to that.
    from: context.length,
    to: kept.length + MARKER.length,
    budget,
  });

  return kept + MARKER;
}

/**
 * Brings a system prompt plus messages inside the total character budget by
 * dropping the oldest messages first.
 *
 * The final message is always kept — it carries the question and its context,
 * and a request without it is not a cheaper version of the request, it is a
 * different one. If that message alone exceeds the budget the array is returned
 * with just it: `fitContext` is what bounds a single message, and this function
 * does not second-guess it by cutting into delimited text.
 */
export function fitMessages(system: string, messages: readonly AiMessage[]): AiMessage[] {
  if (messages.length === 0) return [];

  const sizeOf = (m: AiMessage) => m.content.length;
  const budget = MAX_PROMPT_CHARS - system.length;

  const last = messages[messages.length - 1]!;
  const kept: AiMessage[] = [last];
  let total = sizeOf(last);

  // Walk backwards through the history, newest first, keeping what fits.
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    const candidate = messages[i]!;
    if (total + sizeOf(candidate) > budget) break;
    kept.unshift(candidate);
    total += sizeOf(candidate);
  }

  if (kept.length !== messages.length) {
    log.info("ai history trimmed to budget", {
      from: messages.length,
      to: kept.length,
      chars: total,
      budget,
    });
  }

  return kept;
}

/** Total characters a request will send, for logging and tests. */
export function promptChars(system: string, messages: readonly AiMessage[]): number {
  return system.length + messages.reduce((n, m) => n + m.content.length, 0);
}
