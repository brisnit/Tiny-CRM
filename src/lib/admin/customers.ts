import "server-only";

import { db } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/admin/authorize";
import { activeGrantWhere, effectiveFrom, GRANT_SELECT } from "@/lib/plan-grants";

/**
 * Reads for the admin panel.
 *
 * Separate from `src/lib/actions/admin.ts` because that module carries the
 * `"use server"` directive: every one of its exports becomes a POST endpoint,
 * so a read helper living there would be a reachable endpoint that happens to
 * return data, and a non-async export there is a build-time error. Reads here,
 * mutations there.
 *
 * Every function still calls `requirePlatformAdmin()` itself. Being on the
 * read side is not a reason to check less.
 */

/** The effective entitlement for one account, as the admin panel shows it. */
export async function entitlementForAdmin(userId: string) {
  await requirePlatformAdmin();
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, planGrants: { where: activeGrantWhere(), select: GRANT_SELECT } },
  });
  return effectiveFrom(user.plan, user.planGrants);
}
