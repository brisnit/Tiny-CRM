import { Panel, PanelHeader } from "@/components/ui/surface";
import { Avatar } from "@/components/ui/avatar";
import { ProfileForm } from "@/components/app/settings-forms";
import { requireUser, getUserWorkspaces } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/dates";
import { WORKSPACE_ROLE } from "@/lib/enums";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Profile" };

export default async function ProfileSettings() {
  const user = await requireUser();
  const [full, workspaces] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, name: true, email: true, jobTitle: true, timezone: true, createdAt: true },
    }),
    getUserWorkspaces(user.id),
  ]);

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader title="Profile" description="How you appear across Tiny CRM" />
        <div className="flex items-center gap-4 border-t border-hairline p-4">
          <Avatar name={full.name} size="xl" />
          <div>
            <p className="text-[15px] font-semibold text-body">{full.name}</p>
            <p className="text-[13px] text-muted">{full.email}</p>
            <p className="mt-0.5 text-[11.5px] text-faint">Member since {formatDate(full.createdAt)}</p>
          </div>
        </div>
        <div className="border-t border-hairline p-4">
          <ProfileForm
            name={full.name}
            jobTitle={full.jobTitle}
            timezone={full.timezone}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Your workspaces" description="Where you have access and at what level" />
        <ul className="divide-y divide-hairline border-t border-hairline">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="flex items-center gap-3 px-4 py-3">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: workspace.color }} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-body">{workspace.name}</span>
              <Badge tone={WORKSPACE_ROLE.tone(workspace.role)}>{WORKSPACE_ROLE.label(workspace.role)}</Badge>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
