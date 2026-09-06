import { redirect } from "next/navigation";

import { OnboardingFlow } from "@/components/app/onboarding";
import { requireActor } from "@/lib/auth/access";

export const metadata = { title: "Welcome" };

export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const actor = await requireActor();
  const workspaces = actor.memberships;
  const params = await searchParams;

  // Onboarding is for setting up the first workspace. Once one exists, this
  // screen has nothing left to do.
  if (workspaces.length > 0 && actor.identity.onboardedAt) redirect("/home");

  return (
    <OnboardingFlow
      firstName={actor.identity.name.split(" ")[0] ?? "there"}
      hasWorkspace={workspaces.length > 0}
      selectedPlan={typeof params.plan === "string" ? params.plan : null}
    />
  );
}
