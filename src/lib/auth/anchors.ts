import type { Prisma } from "@/generated/prisma/client";

import type { ScopeEntry } from "@/lib/validation/scope";

/**
 * Turning named anchors into anchors that exist.
 *
 * Three callers need exactly this check and must reach the same verdict:
 * issuing an invitation, redeeming one, and changing a membership's scope. An
 * id is never trusted because of where it arrived from — not from a form, and
 * not from an invitation payload written days earlier by somebody who may since
 * have lost the access that let them name it.
 *
 * Every anchor must be live in *this* workspace, of the kind claimed, and not
 * archived. Anything else is reported, and the caller fails the whole
 * operation: a partially honoured grant set is worse than a refusal, because
 * nobody can see which half they got.
 */

export type AnchorResolution =
  | { ok: true; entries: ScopeEntry[] }
  | { ok: false; unresolvable: ScopeEntry[] };

/**
 * Checks every entry against the live tables.
 *
 * Reads through whatever client it is handed, so it inherits that caller's
 * tenant context and its restriction. That is deliberate: an anchor the caller
 * cannot see is indistinguishable from one that does not exist, which is the
 * same rule `grantRecordAccess` has always applied.
 *
 * Archived anchors are refused. An archived opportunity is in the trash; access
 * to it is access to something somebody decided was over, and granting it is
 * never what was meant. Existing grants are left alone when a record is
 * archived — archival is reversible and revocation is not.
 */
export async function resolveAnchors(
  client: Prisma.TransactionClient,
  workspaceId: string,
  entries: readonly ScopeEntry[],
): Promise<AnchorResolution> {
  if (entries.length === 0) return { ok: true, entries: [] };

  const wanted = { opportunity: [] as string[], project: [] as string[] };
  for (const entry of entries) wanted[entry.entityType].push(entry.entityId);

  const [opportunities, projects] = await Promise.all([
    wanted.opportunity.length
      ? client.opportunity.findMany({
          where: { id: { in: wanted.opportunity }, workspaceId, archivedAt: null },
          select: { id: true },
        })
      : Promise.resolve([]),
    wanted.project.length
      ? client.project.findMany({
          where: { id: { in: wanted.project }, workspaceId, archivedAt: null },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const live = new Set([
    ...opportunities.map((row) => `opportunity:${row.id}`),
    ...projects.map((row) => `project:${row.id}`),
  ]);

  const unresolvable = entries.filter(
    (entry) => !live.has(`${entry.entityType}:${entry.entityId}`),
  );

  return unresolvable.length > 0
    ? { ok: false, unresolvable }
    : { ok: true, entries: [...entries] };
}

/** How an unresolvable anchor is described in a log line, never to the reader. */
export function describeAnchors(entries: readonly ScopeEntry[]): string {
  return entries.map((entry) => `${entry.entityType}:${entry.entityId}`).join(", ");
}
