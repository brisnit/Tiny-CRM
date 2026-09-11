import { Panel, PanelHeader } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/empty-state";
import { TeamManager } from "@/components/app/team-manager";
import { requireActor } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { invitationStatus } from "@/lib/auth/invitations";
import { readScope } from "@/lib/scope";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Team" };

/**
 * Who is in this workspace, and who has been asked to be.
 *
 * Scoped to one workspace rather than showing every workspace the actor belongs
 * to: a team is a property of a business, and "invite someone" needs an
 * unambiguous answer to "to what". The workspace switcher already decides that
 * everywhere else in the app, so this page follows it.
 */
export default async function TeamSettings() {
  const actor = await requireActor();
  const scope = await readScope();

  // "All businesses" has no single team to manage. Fall back to the first
  // workspace so the page is never empty for a reason the user cannot see.
  const membership =
    actor.memberships.find((m) => m.id === scope) ?? actor.memberships[0] ?? null;

  if (!membership) {
    return (
      <Panel>
        <PanelHeader title="Team" description="Invite the people you work with." />
        <EmptyState title="No workspace yet" description="Create a workspace before inviting anyone." />
      </Panel>
    );
  }

  const workspaceId = membership.id;
  const manages = can(membership.role, "members:manage");

  const [workspace, invitations] = await scopedRead([workspaceId], async () => {
    return Promise.all([
      db.workspace.findFirst({
        where: { id: workspaceId },
        select: {
          id: true,
          name: true,
          members: {
            select: {
              role: true,
              createdAt: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      }),
      // Invitations are only anyone's business if you can act on them, and the
      // list contains addresses that were never accepted. A member who cannot
      // manage the team has no reason to read it.
      manages
        ? db.workspaceInvitation.findMany({
            where: { workspaceId },
            select: {
              id: true, email: true, role: true, scopeMode: true,
              createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true,
              invitedBy: { select: { name: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          })
        : Promise.resolve([]),
    ]);
  });

  if (!workspace) {
    return (
      <Panel>
        <PanelHeader title="Team" description="Invite the people you work with." />
        <EmptyState title="Workspace unavailable" description="Try reloading the page." />
      </Panel>
    );
  }

  const owners = workspace.members.filter((m) => m.role === "owner").length;

  return (
    <TeamManager
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      actorRole={membership.role}
      actorUserId={actor.identity.id}
      ownerCount={owners}
      members={workspace.members
        .map((m) => ({
          userId: m.user.id,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          joinedAt: m.createdAt.toISOString(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))}
      invitations={invitations.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        scopeMode: invite.scopeMode,
        invitedBy: invite.invitedBy?.name ?? null,
        invitedAt: invite.createdAt.toISOString(),
        status: invitationStatus(invite),
      }))}
    />
  );
}
