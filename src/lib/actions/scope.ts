"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { PROJECT_COOKIE, SCOPE_COOKIE } from "@/lib/scope";

const YEAR = 60 * 60 * 24 * 365;

export async function setScope(scope: string) {
  const store = await cookies();
  store.set(SCOPE_COOKIE, scope, { path: "/", maxAge: YEAR, sameSite: "lax" });
  // Changing workspace changes every list on the page, so refresh the tree.
  store.delete(PROJECT_COOKIE);
  revalidatePath("/", "layout");
}

export async function setProjectFocus(projectId: string | null) {
  const store = await cookies();
  if (!projectId || projectId === "all") {
    store.delete(PROJECT_COOKIE);
  } else {
    store.set(PROJECT_COOKIE, projectId, { path: "/", maxAge: YEAR, sameSite: "lax" });
  }
  revalidatePath("/", "layout");
}

export async function setTheme(theme: "light" | "dark" | "system") {
  const store = await cookies();
  store.set("tc_theme", theme, { path: "/", maxAge: YEAR, sameSite: "lax" });
}
