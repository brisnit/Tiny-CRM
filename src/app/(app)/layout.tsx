import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/shell";
import { getShellData } from "@/lib/data/shell";
import { getActor, resolveReadScope } from "@/lib/auth/access";
import { readProjectFocus, readScope } from "@/lib/scope";

/**
 * Onboarding lives inside this route group but must not be wrapped in the shell
 * — the shell needs a workspace, and the whole point of /welcome is that there
 * is not one yet. Without this exclusion the layout redirects /welcome to
 * /welcome forever, and a brand-new account can never get past sign-up.
 *
 * This was invisible locally: the seeded demo account already has a workspace
 * and `onboardedAt` set, so every local run entered at /home and never rendered
 * /welcome at all. It took a real sign-up on the deployed build to surface it.
 */
const WITHOUT_SHELL = new Set(["/welcome"]);

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // A signed-out visitor is redirected rather than shown an error. src/proxy.ts
  // catches most of these at the edge; this is the authoritative check, and it
  // also covers a cookie that is present but no longer resolves to a live
  // account (expired, deactivated, deleted).
  const actor = await getActor();
  if (!actor) redirect("/login");

  const pathname = (await headers()).get("x-pathname") ?? "";
  if (WITHOUT_SHELL.has(pathname)) return <>{children}</>;

  const workspaces = actor.memberships;

  // A brand-new account has no workspace yet; onboarding creates the first one.
  if (workspaces.length === 0) redirect("/welcome");

  const scopeCookie = await readScope();
  const projectFocus = await readProjectFocus();
  const { workspaceIds, isAll } = await resolveReadScope(scopeCookie);
  const scope = isAll ? "all" : (workspaceIds[0] ?? "all");

  const data = await getShellData(actor, scope, workspaceIds, projectFocus);

  return <AppShell data={data}>{children}</AppShell>;
}
