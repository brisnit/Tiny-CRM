import { AppShell } from "@/components/app/shell";
import { getShellData } from "@/lib/data/shell";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readProjectFocus, readScope } from "@/lib/scope";
import { redirect } from "next/navigation";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const actor = await requireActor();
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
