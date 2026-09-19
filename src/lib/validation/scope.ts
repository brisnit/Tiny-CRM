import { z } from "zod";

import { zId } from "@/lib/validation/common";

/**
 * What an invitation or a scope change is allowed to say about access.
 *
 * One schema, used in three places that must agree: issuing an invitation,
 * redeeming one, and changing a membership's scope. Writing it once is the
 * point — a payload validated generously at issue and strictly at acceptance
 * is a payload that can mean two different things, and the gap between those
 * meanings is where an invitation quietly grants more or less than it said.
 */

/** The record kinds a grant may name. Anchors, and nothing else. */
export const ANCHOR_TYPES = ["opportunity", "project"] as const;
export type AnchorType = (typeof ANCHOR_TYPES)[number];

export const scopeEntrySchema = z.object({
  entityType: z.enum(ANCHOR_TYPES),
  entityId: zId,
});
export type ScopeEntry = z.infer<typeof scopeEntrySchema>;

/**
 * A ceiling, not a guess. A hundred anchors is far past any real invitation and
 * well short of anything that would make materialization slow; its job is to
 * stop a payload that is large by accident or on purpose.
 */
export const MAX_SCOPE_ENTRIES = 100;

export const scopeListSchema = z.array(scopeEntrySchema).max(MAX_SCOPE_ENTRIES);

export const SCOPE_MODES = ["workspace", "restricted"] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];
export const scopeModeSchema = z.enum(SCOPE_MODES);

/** Two anchors are the same when they name the same record, not the same entry. */
export function dedupeScope(entries: readonly ScopeEntry[]): ScopeEntry[] {
  const seen = new Set<string>();
  const out: ScopeEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.entityType}:${entry.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The rule tying the two fields together.
 *
 * `workspace` with anchors would be an invitation that names work and then
 * grants everything, which reads as a mistake whichever way it was meant.
 * `restricted` with none would be a member who can reach nothing and cannot be
 * told why. Both are refused rather than silently normalised.
 */
export function scopeModeError(mode: ScopeMode, entries: readonly ScopeEntry[]): string | null {
  if (mode === "workspace") {
    return entries.length > 0
      ? "An invitation to the entire workspace cannot also name particular records."
      : null;
  }
  return entries.length === 0
    ? "Limited access needs at least one opportunity or project."
    : null;
}

/**
 * Reads a stored scope payload.
 *
 * Returns null for anything that is not a valid list — malformed JSON, a shape
 * that no longer matches, an entry naming a kind this build does not know. The
 * caller treats null as "this grants nothing", because the honest reading of a
 * payload we cannot understand is not a smaller payload, it is none.
 */
export function parseStoredScope(raw: string): ScopeEntry[] | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = scopeListSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return dedupeScope(parsed.data);
}

/** Serialises a scope payload for storage, deduplicated. */
export function serialiseScope(entries: readonly ScopeEntry[]): string {
  return JSON.stringify(dedupeScope(entries));
}
