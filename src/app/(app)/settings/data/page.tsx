import { Database, Download, Upload } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { ImportExport } from "@/components/app/import-export";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Import & export" };

export default async function DataSettings() {
  const actor = await requireActor();
  const workspaces = actor.memberships;
  const { workspaceIds, workspaceId } = await resolveReadScope(await readScope());
  const where = { workspaceId: { in: workspaceIds } };

  const [contacts, companies, deals, projects, opportunities, tasks] = await scopedRead(workspaceIds, async () => {
    return Promise.all([
      db.contact.count({ where }),
      db.company.count({ where }),
      db.deal.count({ where }),
      db.project.count({ where }),
      db.opportunity.count({ where }),
      db.task.count({ where }),
    ]);
  });

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Export"
          description="Everything in the current scope, as CSV"
          icon={<Download />}
        />
        <div className="border-t border-hairline p-4">
          <ImportExport
            mode="export"
            counts={{ contacts, companies, deals, projects, opportunities, tasks }}
            workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
            defaultWorkspaceId={workspaceId}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Import"
          description="Bring contacts or companies in from a CSV"
          icon={<Upload />}
        />
        <div className="border-t border-hairline p-4">
          <ImportExport
            mode="import"
            counts={{ contacts, companies, deals, projects, opportunities, tasks }}
            workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
            defaultWorkspaceId={workspaceId}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Coming from another CRM?" icon={<Database />} />
        <div className="space-y-3 border-t border-hairline p-4 text-[12.5px] leading-relaxed text-muted">
          <p>
            HubSpot, Salesforce and Google Contacts all export CSV, and the importer matches their column names
            without you mapping anything: it normalises headers and accepts the common variants of each field, so
            “First Name”, “firstname” and “Given Name” all land in the same place.
          </p>
          <p>
            Rows are matched on email for contacts and on name for companies. An existing match is skipped rather
            than duplicated, so re-running the same file is safe. A contact referencing a company you do not have
            yet creates that company, so nothing arrives orphaned.
          </p>
          <p>
            Direct API connectors are the natural next step; they would feed the same import path rather than a
            parallel one.
          </p>
        </div>
      </Panel>
    </div>
  );
}
