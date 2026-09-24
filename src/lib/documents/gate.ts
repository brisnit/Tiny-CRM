import "server-only";

import { currentTenantScope } from "@/lib/tenant-db";
import { AppError } from "@/lib/errors";
import { requireFlag, isEnabled, type FlagKey } from "@/lib/flags";

/**
 * The three gates in front of Document Intelligence.
 *
 * `files` — may this workspace store documents at all?
 * `ai` — may this workspace use Tiny AI?
 * `documentAi` — may Tiny read the documents themselves?
 *
 * Three rather than one because they are three different consents. Storing a
 * PDF is not reading it, and answering a question from a CRM record is not
 * answering one from the inside of somebody's contract. A workspace that wants
 * file storage and the daily brief has not thereby asked us to parse its
 * procurement documents.
 *
 * ---------------------------------------------------------------------------
 * Why this module asserts a tenant context
 * ---------------------------------------------------------------------------
 *
 * `FeatureFlag` is workspace-scoped and under row-level security:
 *
 *   USING ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
 *
 * A workspace override is therefore visible only while `app.workspace_ids` is
 * set. Read with no tenant context the row is filtered out, `isEnabled` falls
 * back to the built-in default, and the flag is **silently ignored**.
 *
 * That defect has now happened three times in this codebase: the document
 * download route, the Project page — which reached production, where the
 * Documents panel refused to render for the one workspace that had the flag —
 * and the AI chat route. Every occurrence was a review miss, and reviews are
 * evidently not the control.
 *
 * So this module refuses to guess. If there is no ambient tenant transaction it
 * throws instead of reading, which converts the failure from "quietly used the
 * default" into "stopped, loudly, with a stack trace". The check deliberately
 * does **not** open a context of its own: a gate that establishes its own
 * authority is not a gate, and the caller has to have earned the workspace it
 * is asking about.
 *
 * It is also deliberately not PostgreSQL-only. SQLite has no policies, so on
 * SQLite the defect is invisible — which is exactly why it survived CI twice.
 * Asserting the *call shape* rather than the *behaviour* means the fast suite
 * and the browser suite catch it too. That is why this reads
 * `currentTenantScope()` and not `currentTenantClient()`: the latter answers
 * "is there an ambient transaction", which is always `null` on SQLite, where
 * `withTenantContext` opens none by design.
 *
 * One honest limit: the marker is inherited by work detached from a request
 * (`runDetached`), whose transaction has since closed. Such work opens its own
 * context before doing anything, so in practice the marker is re-established —
 * but this is a developer tripwire, not the security boundary. Row-level
 * security is the boundary, and it is unaffected either way.
 */

/** Every gate Document Intelligence stands behind, in the order they are read. */
export const DOCUMENT_INTELLIGENCE_FLAGS = ["files", "ai", "documentAi"] as const satisfies readonly FlagKey[];

/**
 * Throws unless a tenant context is already open.
 *
 * Exported so that anything else reading a workspace-scoped flag can make the
 * same assertion rather than reinventing the reasoning.
 */
export function assertTenantContext(operation: string): void {
  if (currentTenantScope()) return;
  throw new AppError("internal", "Something went wrong. Please try again.", {
    internal:
      `${operation} read a workspace-scoped feature flag with no tenant context. ` +
      "FeatureFlag is under row-level security, so the workspace override would have " +
      "been filtered out and the built-in default used instead — silently ignoring " +
      "the flag. Establish the context from the caller's own memberships first.",
  });
}

/**
 * Throws unless all three gates are open for this workspace.
 *
 * Must be called inside a tenant context the caller has already earned, from
 * their own memberships. Not from a workspace id supplied by a browser.
 */
export async function requireDocumentIntelligence(workspaceId: string): Promise<void> {
  assertTenantContext("requireDocumentIntelligence");
  for (const flag of DOCUMENT_INTELLIGENCE_FLAGS) {
    await requireFlag(flag, workspaceId);
  }
}

/**
 * The same three gates as a question rather than an assertion, for a caller
 * that needs to decide rather than refuse — a background job skipping work, or
 * a page deciding whether to render a panel.
 */
export async function documentIntelligenceEnabled(workspaceId: string): Promise<boolean> {
  assertTenantContext("documentIntelligenceEnabled");
  for (const flag of DOCUMENT_INTELLIGENCE_FLAGS) {
    if (!(await isEnabled(flag, workspaceId))) return false;
  }
  return true;
}
