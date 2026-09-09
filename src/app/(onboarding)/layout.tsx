import { redirect } from "next/navigation";

import { getActor } from "@/lib/auth/access";
import { OnboardingEscape } from "@/components/app/onboarding-escape";

/**
 * Onboarding lives in its own route group, deliberately.
 *
 * It used to sit inside `(app)`, whose layout renders the whole application
 * shell — a sidebar, a workspace switcher, a command bar — all of which need a
 * workspace, which is the one thing an account in onboarding does not have. The
 * layout worked around that by reading the `x-pathname` header and returning
 * bare children for `/welcome` instead of the shell.
 *
 * That made one layout render two structurally different trees depending on a
 * request header, and the client router cannot follow that. Navigating to
 * `/home` — which the marketing site's "Open Tiny CRM" link does — server
 * redirects to `/welcome` for an account with no workspace; the router
 * reconciled the redirect against the layout it already held and produced an
 * empty tree. A completely blank white page, on the only screen that account
 * can reach. A hard load of the same URL rendered correctly, which is what made
 * it look like an account problem rather than a routing one.
 *
 * Two route groups mean two layouts. A redirect from `(app)` to here crosses a
 * layout boundary, so the router tears the old tree down and builds this one
 * instead of trying to reconcile them. The header dependency is gone with it.
 */
export default async function OnboardingLayout({ children }: LayoutProps<"/">) {
  // Same authoritative check the app layout makes: a cookie that no longer
  // resolves to a live account is signed out, not shown an error.
  const actor = await getActor();
  if (!actor) redirect("/login");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">{children}</div>
      </div>
      <OnboardingEscape />
    </div>
  );
}
