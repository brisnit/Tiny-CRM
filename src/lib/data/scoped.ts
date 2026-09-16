import "server-only";

import type { ReadScope } from "@/lib/auth/access";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Runs a page's own database reads inside its tenant context.
 *
 * Most pages read through `src/lib/data/*`, which establish context themselves.
 * A handful read directly — a tag list for a filter bar, a task count for a
 * header — and those queries need the same context or RLS returns nothing and
 * the page renders as though the workspace were empty.
 *
 * The scope passed here must come from `resolveReadScope`, which derives it
 * from the actor's memberships and identity. A workspace id taken from the URL
 * or a cookie may *narrow* that set — that is what the scope cookie does — but
 * it can never introduce an id the actor does not already have, because
 * `resolveReadScope` intersects with the memberships before returning.
 * Authorisation is decided there; this only tells the database what was decided.
 *
 * The identity half matters just as much: without it the person-scoped policies
 * (`SavedView`, `Notification`) match nothing at all. Taking the whole
 * `ReadScope` rather than a bare id list is what makes that impossible to
 * forget.
 */
export function scopedRead<T>(scope: ReadScope, fn: () => Promise<T>): Promise<T> {
  return withTenantContext(scope, fn);
}
