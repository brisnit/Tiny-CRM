import "server-only";

import { cache } from "react";

import { db } from "@/lib/db";
import { isProduction } from "@/lib/env";

/**
 * Server-side feature flags.
 *
 * Evaluated on the server so a flag can gate a security-sensitive capability —
 * a `NEXT_PUBLIC_` environment variable is visible to, and editable by, the
 * client and is therefore never a control. Resolution order is
 * workspace-specific row → global row → built-in default.
 */

export const FLAGS = {
  ai: { default: true, description: "Tiny AI answers, summaries and the daily brief" },
  automations: { default: true, description: "Automation rules and the event dispatcher" },
  files: { default: false, description: "File uploads (requires object storage)" },
  integrations: { default: false, description: "Live email and calendar sync" },
  experimentalSearch: { default: false, description: "Full-text search backend" },
  auditLogUi: { default: true, description: "Audit log screen in settings" },
} as const;

export type FlagKey = keyof typeof FLAGS;

/** Reads every flag once per request. */
const loadFlags = cache(async (workspaceId: string | null) => {
  const rows = await db.featureFlag.findMany({
    where: workspaceId ? { OR: [{ workspaceId: null }, { workspaceId }] } : { workspaceId: null },
    select: { key: true, enabled: true, workspaceId: true },
  });

  const resolved = new Map<string, boolean>();
  // Global rows first, then workspace rows so the more specific one wins.
  for (const row of rows.filter((r) => !r.workspaceId)) resolved.set(row.key, row.enabled);
  for (const row of rows.filter((r) => r.workspaceId)) resolved.set(row.key, row.enabled);
  return resolved;
});

export async function isEnabled(key: FlagKey, workspaceId?: string | null): Promise<boolean> {
  const flags = await loadFlags(workspaceId ?? null);
  return flags.get(key) ?? FLAGS[key].default;
}

/** All flag values, for a settings screen. */
export async function allFlags(workspaceId?: string | null) {
  const flags = await loadFlags(workspaceId ?? null);
  return (Object.keys(FLAGS) as FlagKey[]).map((key) => ({
    key,
    description: FLAGS[key].description,
    enabled: flags.get(key) ?? FLAGS[key].default,
    overridden: flags.has(key),
  }));
}

/**
 * Throws when a capability is disabled. Used at the top of a route or action so
 * a disabled feature is unreachable rather than merely hidden.
 */
export async function requireFlag(key: FlagKey, workspaceId?: string | null): Promise<void> {
  if (await isEnabled(key, workspaceId)) return;
  const { AppError } = await import("@/lib/errors");
  throw new AppError("forbidden", "That feature is not enabled for this workspace.");
}

export { isProduction };
