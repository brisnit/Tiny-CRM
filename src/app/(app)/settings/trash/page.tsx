import { Panel, PanelHeader } from "@/components/ui/surface";
import { TrashList } from "@/components/app/trash-list";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { listTrash } from "@/lib/data/trash";
import { readScope } from "@/lib/scope";

export const metadata = { title: "Trash" };

/**
 * Archived records, restorable.
 *
 * Scoped through `resolveReadScope`, so this shows exactly the workspaces the
 * caller belongs to and nothing else — a trash screen that leaked would be a
 * particularly bad one, since it lists what somebody tried to get rid of.
 */
export default async function TrashSettings() {
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const { items } = await listTrash(workspaceIds);

  return (
    <Panel>
      <PanelHeader
        title="Trash"
        description="Archived records, and how to put them back"
      />
      <div className="border-t border-hairline">
        <TrashList
          items={items.map((item) => ({
            id: item.id,
            type: item.type,
            label: item.label,
            detail: item.detail,
            workspaceName: item.workspaceName,
            archivedAt: item.archivedAt.toISOString(),
            daysArchived: item.daysArchived,
          }))}
        />
      </div>
      <p className="border-t border-hairline px-4 py-2.5 text-[11.5px] text-faint">
        Archived records keep their history and do not count against your plan. Permanent
        deletion is a separate action on the record itself, and asks you to type its name.
      </p>
    </Panel>
  );
}
