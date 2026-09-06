import { Panel, PanelHeader } from "@/components/ui/surface";
import { TagManager } from "@/components/app/tag-manager";
import { requireActor } from "@/lib/auth/access";
import { db } from "@/lib/db";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Tags" };

export default async function TagSettings() {
  const actor = await requireActor();
  const workspaces = actor.memberships;

  const tags = await scopedRead(workspaces.map((w) => w.id), async () => {
    return db.tag.findMany({
      where: { workspaceId: { in: workspaces.map((w) => w.id) } },
      select: {
        id: true, name: true, color: true, workspaceId: true,
        _count: { select: { links: true } },
      },
      orderBy: { name: "asc" },
    });
  });

  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-muted">
        Tags work across every record type — a contact, a company, a deal and an opportunity can all carry
        “Higher Education”. New tags are created as you type them, so tagging never means a trip to settings.
      </p>

      {workspaces.map((workspace) => (
        <Panel key={workspace.id}>
          <PanelHeader
            title={workspace.name}
            icon={<span className="size-2.5 rounded-full" style={{ background: workspace.color }} />}
          />
          <TagManager
            workspaceId={workspace.id}
            tags={tags
              .filter((t) => t.workspaceId === workspace.id)
              .map((t) => ({ id: t.id, name: t.name, color: t.color, useCount: t._count.links }))}
          />
        </Panel>
      ))}
    </div>
  );
}
