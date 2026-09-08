import { redirect } from "next/navigation";

import { OnboardingFlow } from "@/components/app/onboarding";
import { requireActor } from "@/lib/auth/access";

export const metadata = { title: "Welcome" };

export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const actor = await requireActor();
  const workspaces = actor.memberships;
  const params = await searchParams;

  // Onboarding is for setting up the first workspace. Once one exists, this
  // screen has nothing left to do — unless the person is deliberately coming
  // back to it.
  //
  // Skipping setup is a legitimate choice and it now lands on a real, empty
  // home screen rather than a trap. But "skip" should not mean "never again":
  // `?resume=1` reopens the guided flow so someone who skipped on their first
  // evening can walk through it later without creating a second account.
  const resuming = params.resume === "1";
  if (workspaces.length > 0 && actor.identity.onboardedAt && !resuming) redirect("/home");

  return (
    <OnboardingFlow
      firstName={actor.identity.name.split(" ")[0] ?? "there"}
      hasWorkspace={workspaces.length > 0}
      selectedPlan={typeof params.plan === "string" ? params.plan : null}
    />
  );
}
