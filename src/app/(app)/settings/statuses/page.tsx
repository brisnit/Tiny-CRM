import { Panel, PanelHeader } from "@/components/ui/surface";
import { StatusManager } from "@/components/app/status-manager";
import { requireActor } from "@/lib/auth/access";
import { db } from "@/lib/db";

export const metadata = { title: "Project statuses" };

export default async function StatusSettings() {
  const actor = await requireActor();
  const workspaces = actor.memberships;

  const statuses = await db.projectStatus.findMany({
    where: { workspaceId: { in: workspaces.map((w) => w.id) } },
    select: {
      id: true, name: true, color: true, order: true, isTerminal: true, isDefault: true,
      workspaceId: true,
      _count: { select: { projects: true } },
    },
    orderBy: [{ workspaceId: "asc" }, { order: "asc" }],
  });

  return (
    <div className="space-y-5">
      {workspaces.map((workspace) => (
        <Panel key={workspace.id}>
          <PanelHeader
            title={workspace.name}
            description="Project stages for this business"
            icon={<span className="size-2.5 rounded-full" style={{ background: workspace.color }} />}
          />
          <StatusManager
            workspaceId={workspace.id}
            statuses={statuses
              .filter((s) => s.workspaceId === workspace.id)
              .map((s) => ({
                id: s.id,
                name: s.name,
                color: s.color,
                isTerminal: s.isTerminal,
                isDefault: s.isDefault,
                projectCount: s._count.projects,
              }))}
          />
        </Panel>
      ))}
    </div>
  );
}
