"use client";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WORKSPACE_ROLE } from "@/lib/enums";
import { acceptInvitationById } from "@/lib/actions/team";

/**
 * "Somebody has already invited you" — shown above the setup flow.
 *
 * This is the other half of the fix for the defect that would have met the very
 * first teammate. Onboarding provisions a workspace for anyone who arrives
 * without one, which is right for a person starting their own business and
 * exactly wrong for someone who was invited to a colleague's. The guard cannot
 * tell those apart, so the screen asks instead — and puts the invitation first,
 * where the answer is obvious.
 *
 * Creating a workspace of their own is still one click away below. It is now a
 * choice rather than the only road.
 */
export function PendingInvitations({
  invitations,
}: {
  invitations: {
    id: string;
    workspaceName: string;
    role: string;
    invitedByName: string | null;
  }[];
}) {
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  if (invitations.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-brand-200 bg-brand-50/60 p-5 dark:border-brand-900 dark:bg-brand-950/40">
      <h2 className="text-[15px] font-semibold text-body">
        {invitations.length === 1
          ? "You have been invited to a workspace"
          : `You have been invited to ${invitations.length} workspaces`}
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Joining one adds you to that team&rsquo;s existing data. You do not need a workspace of your
        own unless you want one.
      </p>

      <ul className="mt-4 space-y-2">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-panel px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-medium text-body">
                {invitation.workspaceName}
              </p>
              <p className="text-[12px] text-muted">
                {invitation.invitedByName ? `Invited by ${invitation.invitedByName}` : "You were invited"}
              </p>
            </div>
            <Badge tone={WORKSPACE_ROLE.tone(invitation.role)}>
              {WORKSPACE_ROLE.label(invitation.role, invitation.role)}
            </Badge>
            <Button
              variant="brand"
              size="sm"
              loading={pendingId === invitation.id}
              onClick={async () => {
                setPendingId(invitation.id);
                const result = await acceptInvitationById(invitation.id);
                if (!result.ok) {
                  toast.error(result.error);
                  setPendingId(null);
                  return;
                }
                // A full load, not a router push: the membership just created
                // changes what every layout above this point may render, and a
                // client transition would carry the memberless shell into the
                // new state. Same reasoning as `goHard` in auth-forms.tsx.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.assign("/home");
              }}
            >
              Join
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
