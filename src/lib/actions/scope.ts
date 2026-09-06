"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getActor } from "@/lib/auth/access";
import { isProduction } from "@/lib/env";
import { PROJECT_COOKIE, SCOPE_COOKIE } from "@/lib/scope";
import { zId } from "@/lib/validation/common";

/**
 * View preferences, stored in cookies.
 *
 * **None of these is a permission.** The workspace scope and project focus
 * cookies only narrow what a user is shown; `resolveReadScope()` re-derives the
 * permitted set from the caller's memberships on every read, and a cookie naming
 * a workspace they do not belong to is ignored rather than honoured. That is why
 * these can be cookies at all.
 *
 * They are still hardened, because every export of this module is a public HTTP
 * endpoint:
 *
 *  - **Validated.** Before, an arbitrary string went straight into a `Set-Cookie`
 *    header. A caller could store kilobytes under a name the app sends back on
 *    every subsequent request, which is a self-inflicted request-size problem
 *    and a header-injection surface if a value ever reached an unescaped
 *    context.
 *  - **Membership-checked where it is cheap to do so.** A workspace id is
 *    written only if the caller is actually a member. This is a hygiene measure,
 *    not the isolation control — the read path does not trust the cookie either
 *    way — but it stops the cookie becoming a place to park a foreign id.
 *  - **Explicitly flagged.** `httpOnly` is deliberately *off*: these are read by
 *    the server, but a theme flash on first paint is a real UX cost and nothing
 *    here is a secret.
 */

const YEAR = 60 * 60 * 24 * 365;

const preferenceCookie = {
  path: "/" as const,
  maxAge: YEAR,
  sameSite: "lax" as const,
  secure: isProduction,
};

const zScopeValue = z.union([zId, z.literal("all")]);
const zTheme = z.enum(["light", "dark", "system"]);

/** Switches which workspace the app is scoped to, or "all". */
export async function setScope(scope: string): Promise<void> {
  const parsed = zScopeValue.safeParse(scope);
  if (!parsed.success) return;

  const actor = await getActor();
  if (!actor) return;

  // Only a workspace the caller belongs to is worth storing. An id they do not
  // belong to would be ignored on read anyway; refusing to write it keeps the
  // cookie meaningful.
  if (parsed.data !== "all" && !actor.memberships.some((m) => m.id === parsed.data)) return;

  const store = await cookies();
  store.set(SCOPE_COOKIE, parsed.data, preferenceCookie);
  // Changing workspace changes every list on the page, and a project focus from
  // the previous workspace would no longer resolve.
  store.delete(PROJECT_COOKIE);
  revalidatePath("/", "layout");
}

/** Narrows the app to one project, or clears the focus. */
export async function setProjectFocus(projectId: string | null): Promise<void> {
  const store = await cookies();

  if (!projectId || projectId === "all") {
    store.delete(PROJECT_COOKIE);
    revalidatePath("/", "layout");
    return;
  }

  const parsed = zId.safeParse(projectId);
  if (!parsed.success) return;

  const actor = await getActor();
  if (!actor) return;

  store.set(PROJECT_COOKIE, parsed.data, preferenceCookie);
  revalidatePath("/", "layout");
}

/**
 * Sets the colour theme. The one preference here that a signed-out visitor
 * legitimately sets, since the marketing pages honour it too.
 */
export async function setTheme(theme: string): Promise<void> {
  const parsed = zTheme.safeParse(theme);
  if (!parsed.success) return;

  const store = await cookies();
  store.set("tc_theme", parsed.data, preferenceCookie);
}
