import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { NewWorkspaceForm } from "@/components/app/workspace-forms";
import { requireActor } from "@/lib/auth/access";
import { db } from "@/lib/db";
import { planFor, UNLIMITED } from "@/lib/plans";
import { WORKSPACE_ROLE } from "@/lib/enums";

export const metadata = { title: "Workspaces" };

export default async function WorkspacesSettings() {
  const actor = await requireActor();
  const workspaces = actor.memberships;
  const plan = planFor(actor.identity.plan);

  const details = await db.workspace.findMany({
    where: { id: { in: workspaces.map((w) => w.id) } },
    select: {
      id: true, name: true, description: true, color: true,
      members: { select: { role: true, user: { select: { id: true, name: true, email: true } } } },
      _count: { select: { contacts: true, companies: true, projects: true, deals: true } },
    },
  });

  const atLimit = plan.limits.workspaces !== UNLIMITED && workspaces.length >= plan.limits.workspaces;

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Workspaces"
          description="One per business. Each keeps its own pipelines, statuses and tags."
        />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {details.map((workspace) => (
            <li key={workspace.id} className="px-4 py-3.5">
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                  style={{ background: workspace.color }}
                >
                  {workspace.name.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-body">{workspace.name}</p>
                  {workspace.description ? (
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{workspace.description}</p>
                  ) : null}
                  <p className="mt-1.5 text-[11.5px] text-faint">
                    {workspace._count.contacts} contacts · {workspace._count.companies} companies ·{" "}
                    {workspace._count.projects} projects · {workspace._count.deals} deals
                  </p>
                </div>
              </div>

              <ul className="mt-3 flex flex-wrap gap-2 pl-10">
                {workspace.members.map((member) => (
                  <li
                    key={member.user.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-hairline py-0.5 pl-0.5 pr-2"
                  >
                    <Avatar name={member.user.name} size="xs" />
                    <span className="text-[11.5px] text-body">{member.user.name}</span>
                    <Badge tone={WORKSPACE_ROLE.tone(member.role)}>{WORKSPACE_ROLE.label(member.role)}</Badge>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel>
        <PanelHeader
          title="New workspace"
          description={
            atLimit
              ? `The ${plan.name} plan includes ${plan.limits.workspaces} workspace. Upgrade to add more.`
              : "It arrives with project statuses and two pipelines already set up."
          }
        />
        <div className="border-t border-hairline p-4">
          <NewWorkspaceForm disabled={atLimit} />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Roles" description="What each level can do" />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {WORKSPACE_ROLE.options.map((role) => (
            <li key={role.value} className="flex items-baseline gap-3 px-4 py-2.5">
              <Badge tone={role.tone} className="w-16 justify-center">
                {role.label}
              </Badge>
              <span className="text-[12.5px] text-muted">{role.description}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-hairline px-4 py-3 text-[12px] leading-relaxed text-faint">
          Role checks are enforced on every write in the server action layer, not just hidden in the UI. Inviting
          teammates is the next step for this screen; the membership model and the checks it needs already exist.
        </p>
      </Panel>
    </div>
  );
}
