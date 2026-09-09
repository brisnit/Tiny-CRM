import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/shell";
import { getShellData } from "@/lib/data/shell";
import { getActor, resolveReadScope } from "@/lib/auth/access";
import { readProjectFocus, readScope } from "@/lib/scope";

/**
 * Every route in this group renders the application shell, unconditionally.
 *
 * It did not always. Onboarding used to live here too, and since the shell
 * needs a workspace — the one thing an account in onboarding lacks — the layout
 * read the `x-pathname` header and returned bare children for /welcome instead.
 * One layout, two structurally different trees, chosen by a request header.
 *
 * The client router cannot follow that. Navigating to /home with no workspace
 * server-redirects to /welcome; the router reconciled the redirect against the
 * layout it was already holding and produced an empty tree — a blank white page
 * on the only screen such an account can reach. A hard load of the same URL was
 * fine, which is what disguised it as an account problem.
 *
 * /welcome now lives in its own route group with its own layout, so that
 * redirect crosses a layout boundary and the router rebuilds rather than
 * reconciles. Nothing here branches on a header any more, and nothing should.
 */

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // A signed-out visitor is redirected rather than shown an error. src/proxy.ts
  // catches most of these at the edge; this is the authoritative check, and it
  // also covers a cookie that is present but no longer resolves to a live
  // account (expired, deactivated, deleted).
  const actor = await getActor();
  if (!actor) redirect("/login");

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
