import "server-only";

import { cookies } from "next/headers";

/**
 * Workspace scope — the "which business am I looking at" switch.
 *
 * It lives in a cookie rather than the URL so that every route keeps the user's
 * context without threading a query param through hundreds of links, and so a
 * shared link opens in the recipient's own scope. "all" is the All Businesses
 * view. Data access still verifies membership on every query (resolveScope in
 * src/lib/auth/session.ts) — this cookie is a preference, never a permission.
 */
export const SCOPE_COOKIE = "tc_scope";
export const PROJECT_COOKIE = "tc_project";

export async function readScope(): Promise<string> {
  const store = await cookies();
  return store.get(SCOPE_COOKIE)?.value ?? "all";
}

/** Optional project focus, which narrows the app to one initiative. */
export async function readProjectFocus(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(PROJECT_COOKIE)?.value;
  return value && value !== "all" ? value : null;
}
