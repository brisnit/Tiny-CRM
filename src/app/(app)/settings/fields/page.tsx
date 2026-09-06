import { Panel, PanelHeader } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { FieldManager } from "@/components/app/field-manager";
import { requireActor } from "@/lib/auth/access";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { CUSTOM_FIELD_TYPE, ENTITY_LABEL, type EntityType } from "@/lib/enums";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Custom fields" };

export default async function FieldSettings() {
  const actor = await requireActor();
  const workspaces = actor.memberships;

  const fields = await scopedRead(workspaces.map((w) => w.id), async () => {
    return db.customFieldDef.findMany({
      where: { workspaceId: { in: workspaces.map((w) => w.id) } },
      select: {
        id: true, entityType: true, key: true, label: true, type: true, options: true,
        workspaceId: true, _count: { select: { values: true } },
      },
      orderBy: [{ workspaceId: "asc" }, { entityType: "asc" }, { order: "asc" }],
    });
  });

  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-muted">
        Add the fields your business actually tracks. Numeric and date fields are written to typed columns
        alongside their text form, so they stay filterable and sortable rather than becoming dead metadata.
      </p>

      {workspaces.map((workspace) => (
        <Panel key={workspace.id}>
          <PanelHeader
            title={workspace.name}
            icon={<span className="size-2.5 rounded-full" style={{ background: workspace.color }} />}
          />
          <ul className="divide-y divide-hairline border-t border-hairline">
            {fields
              .filter((f) => f.workspaceId === workspace.id)
              .map((field) => {
                const options = parseJson<string[]>(field.options, []);
                return (
                  <li key={field.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-body">{field.label}</span>
                      <span className="block text-[11.5px] text-faint">
                        {ENTITY_LABEL[field.entityType as EntityType]?.one ?? field.entityType} ·{" "}
                        <code className="font-mono">{field.key}</code>
                        {options.length > 0 ? ` · ${options.join(", ")}` : ""}
                      </span>
                    </span>
                    <Badge tone={CUSTOM_FIELD_TYPE.tone(field.type)}>
                      {CUSTOM_FIELD_TYPE.label(field.type)}
                    </Badge>
                    <span className="w-16 shrink-0 text-right text-[11.5px] text-faint tabular">
                      {field._count.values} in use
                    </span>
                  </li>
                );
              })}
            {fields.filter((f) => f.workspaceId === workspace.id).length === 0 ? (
              <li className="px-4 py-6 text-center text-[13px] text-faint">
                No custom fields in this workspace yet.
              </li>
            ) : null}
          </ul>
          <FieldManager workspaceId={workspace.id} />
        </Panel>
      ))}
    </div>
  );
}
