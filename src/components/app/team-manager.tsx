"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MailPlus, RotateCcw, X } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/select";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { WORKSPACE_ROLE } from "@/lib/enums";
import { ROLES, canAssignRole, isRole, type Role } from "@/lib/auth/permissions";
import { inviteTeamMember, resendInvitation, revokeInvitation } from "@/lib/actions/team";
import { changeMemberRole, removeMember } from "@/lib/actions/settings";

/**
 * The team screen.
 *
 * Everything it hides, the server refuses independently — the role options
 * offered here are filtered by `canAssignRole`, and `assertCanAssignRole` runs
 * again inside every action. Hiding a control is a courtesy to the person using
 * it, never the thing that stops them.
 *
 * Two states are deliberately visible rather than tidied away: the last owner's
 * controls are shown and disabled with the reason attached, and an expired
 * invitation stays in the list until it is dealt with. Both are questions
 * someone will otherwise ask.
 */

type Member = {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  scopeMode: string;
  invitedBy: string | null;
  invitedAt: string;
  status: "pending" | "accepted" | "revoked" | "expired";
};

const STATUS_TONE: Record<Invitation["status"], Parameters<typeof Badge>[0]["tone"]> = {
  pending: "amber",
  accepted: "green",
  revoked: "neutral",
  expired: "neutral",
};

export function TeamManager({
  workspaceId,
  workspaceName,
  actorRole,
  actorUserId,
  ownerCount,
  members,
  invitations,
}: {
  workspaceId: string;
  workspaceName: string;
  actorRole: string;
  actorUserId: string;
  ownerCount: number;
  members: Member[];
  invitations: Invitation[];
}) {
  const router = useRouter();
  const manages = canAssignRole(actorRole, "viewer");

  const assignable = React.useMemo(
    () =>
      ROLES.filter((role) => canAssignRole(actorRole, role)).map((role) => ({
        value: role as Role,
        label: WORKSPACE_ROLE.label(role, role),
      })),
    [actorRole],
  );

  const pending = invitations.filter((i) => i.status === "pending");
  const past = invitations.filter((i) => i.status !== "pending");

  return (
    <div className="space-y-5">
      {manages ? (
        <InviteForm workspaceId={workspaceId} workspaceName={workspaceName} roles={assignable} />
      ) : null}

      <Panel>
        <PanelHeader
          title="Members"
          description={`${members.length} ${members.length === 1 ? "person" : "people"} in ${workspaceName}.`}
        />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {members.map((member) => {
            const isSelf = member.userId === actorUserId;
            const lastOwner = member.role === "owner" && ownerCount <= 1;
            const editable = manages && canAssignRole(actorRole, member.role) && !lastOwner;

            return (
              <li key={member.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar name={member.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-body">
                    {member.name}
                    {isSelf ? <span className="ml-1.5 text-[12px] text-faint">(you)</span> : null}
                  </p>
                  <p className="truncate text-[12px] text-muted">{member.email}</p>
                </div>

                {editable ? (
                  <OptionSelect
                    size="sm"
                    className="w-32"
                    value={member.role}
                    options={assignable}
                    onValueChange={(role) => {
                      if (role === member.role || !isRole(role)) return;
                      void run(
                        () => changeMemberRole({ workspaceId, userId: member.userId, role }),
                        `${member.name} is now ${WORKSPACE_ROLE.label(role, role)}`,
                        router,
                      );
                    }}
                  />
                ) : (
                  <Badge tone={WORKSPACE_ROLE.tone(member.role)}>
                    {WORKSPACE_ROLE.label(member.role, member.role)}
                  </Badge>
                )}

                {manages ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={lastOwner || !canAssignRole(actorRole, member.role)}
                    title={
                      lastOwner
                        ? "A workspace must always have at least one owner."
                        : "Remove from this workspace"
                    }
                    onClick={() => {
                      if (!window.confirm(`Remove ${member.name} from ${workspaceName}?`)) return;
                      void run(
                        () => removeMember(workspaceId, member.userId),
                        `${member.name} no longer has access`,
                        router,
                      );
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>

      {manages ? (
        <Panel>
          <PanelHeader
            title="Pending invitations"
            description="Each link expires after seven days and can be used once."
          />
          {pending.length === 0 ? (
            <div className="border-t border-hairline">
              <EmptyState
                title="Nobody is waiting"
                description="Invitations you send will appear here until they are accepted."
              />
            </div>
          ) : (
            <ul className="divide-y divide-hairline border-t border-hairline">
              {pending.map((invite) => (
                <li key={invite.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] text-body">{invite.email}</p>
                    <p className="text-[12px] text-muted">
                      Invited {new Date(invite.invitedAt).toLocaleDateString()}
                      {invite.invitedBy ? ` by ${invite.invitedBy}` : ""}
                      {invite.scopeMode === "workspace" ? " · entire workspace" : " · limited access"}
                    </p>
                  </div>
                  <Badge tone={WORKSPACE_ROLE.tone(invite.role)}>
                    {WORKSPACE_ROLE.label(invite.role, invite.role)}
                  </Badge>
                  <Badge tone={STATUS_TONE[invite.status]}>Pending</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void run(
                        () => resendInvitation({ workspaceId, invitationId: invite.id }),
                        `Sent a fresh invitation to ${invite.email}`,
                        router,
                      )
                    }
                  >
                    <RotateCcw className="size-3.5" />
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void run(
                        () => revokeInvitation({ workspaceId, invitationId: invite.id }),
                        "Invitation revoked",
                        router,
                      )
                    }
                  >
                    <X className="size-3.5" />
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {past.length > 0 ? (
            <ul className="divide-y divide-hairline border-t border-hairline">
              {past.map((invite) => (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-muted"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{invite.email}</span>
                  <Badge tone={STATUS_TONE[invite.status]}>
                    {invite.status === "accepted"
                      ? "Accepted"
                      : invite.status === "revoked"
                        ? "Revoked"
                        : "Expired"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

function InviteForm({
  workspaceId,
  workspaceName,
  roles,
}: {
  workspaceId: string;
  workspaceName: string;
  roles: { value: Role; label: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>(
    roles.some((r) => r.value === "member") ? "member" : ((roles[0]?.value ?? "viewer") as Role),
  );
  const [pending, setPending] = React.useState(false);

  return (
    <Panel>
      <PanelHeader
        title="Invite a team member"
        description={`They will join ${workspaceName} — not a workspace of their own.`}
      />
      <form
        className="flex flex-wrap items-end gap-3 border-t border-hairline px-4 py-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          const result = await inviteTeamMember({ workspaceId, email, role });
          setPending(false);
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          toast.success(`Invitation sent to ${result.data.email}`);
          setEmail("");
          router.refresh();
        }}
      >
        <div className="min-w-[220px] flex-1">
          <Field label="Email address" htmlFor="invite-email">
            <Input
              id="invite-email"
              type="email"
              required
              autoComplete="off"
              placeholder="teammate@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
        </div>
        <div className="w-40">
          <Field label="Role" htmlFor="invite-role">
            <OptionSelect
              value={role}
              options={roles}
              onValueChange={(next) => isRole(next) && setRole(next)}
              name="role"
            />
          </Field>
        </div>
        {/*
          Access is fixed to the whole workspace for now and the control says so
          rather than being absent — the invitation already stores a scope, and
          the selector lands with scoped access. Showing nothing here would make
          the later arrival of scoped invitations look like a change of rules.
        */}
        <div className="w-48">
          <Field label="Access" htmlFor="invite-access">
            <OptionSelect
              value="workspace"
              disabled
              options={[{ value: "workspace", label: "Entire workspace" }]}
              name="access"
            />
          </Field>
        </div>
        <Button type="submit" variant="brand" loading={pending} disabled={!email.trim()}>
          <MailPlus className="size-4" />
          Send invitation
        </Button>
      </form>
    </Panel>
  );
}

/** Runs an action, reports it, and refreshes — the same three lines everywhere. */
async function run(
  fn: () => Promise<{ ok: boolean; error?: string }>,
  success: string,
  router: ReturnType<typeof useRouter>,
): Promise<void> {
  const result = await fn();
  if (!result.ok) {
    toast.error(result.error ?? "That did not work.");
    return;
  }
  toast.success(success);
  router.refresh();
}
