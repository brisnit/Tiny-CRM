import { redirect } from "next/navigation";

import { OnboardingFlow } from "@/components/app/onboarding";
import { requireUser, getUserWorkspaces } from "@/lib/auth/session";

export const metadata = { title: "Welcome" };

export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const user = await requireUser();
  const workspaces = await getUserWorkspaces(user.id);
  const params = await searchParams;

  // Onboarding is for setting up the first workspace. Once one exists, this
  // screen has nothing left to do.
  if (workspaces.length > 0 && user.onboardedAt) redirect("/home");

  return (
    <OnboardingFlow
      firstName={user.name.split(" ")[0] ?? "there"}
      hasWorkspace={workspaces.length > 0}
      selectedPlan={typeof params.plan === "string" ? params.plan : null}
    />
  );
}
