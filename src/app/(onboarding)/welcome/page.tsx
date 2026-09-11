import { redirect } from "next/navigation";

import { OnboardingFlow } from "@/components/app/onboarding";
import { PendingInvitations } from "@/components/app/pending-invitations";
import { requireActor } from "@/lib/auth/access";
import { pendingInvitationsFor } from "@/lib/auth/invitations";

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

  // Somebody may have invited this person before they ever got here. Onboarding
  // provisions a workspace for anyone who arrives without one, which is right
  // for a founder and exactly wrong for an invited teammate — and the guard
  // cannot tell them apart. So the invitation is offered first, and creating a
  // workspace of their own stays one click away below.
  const invitations = await pendingInvitationsFor({
    id: actor.identity.id,
    email: actor.identity.email,
  });

  return (
    <>
      <PendingInvitations
        invitations={invitations.map((invitation) => ({
          id: invitation.id,
          workspaceName: invitation.workspaceName,
          role: invitation.role,
          invitedByName: invitation.invitedByName,
        }))}
      />
      <OnboardingFlow
        firstName={actor.identity.name.split(" ")[0] ?? "there"}
        hasWorkspace={workspaces.length > 0}
        selectedPlan={typeof params.plan === "string" ? params.plan : null}
      />
    </>
  );
}
