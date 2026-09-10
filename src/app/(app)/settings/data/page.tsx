import { Database, Download, History, Upload } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { ImportExport } from "@/components/app/import-export";
import { SpreadsheetImport } from "@/components/app/spreadsheet-import";
import { ImportHistory } from "@/components/app/import-history";
import { formatDate } from "@/lib/dates";
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

  const batches = await scopedRead(workspaceIds, () =>
    db.importBatch.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, sourceName: true, sheetName: true, status: true, rowCount: true,
        createdCount: true, matchedCount: true, skippedCount: true, errorCount: true,
        createdAt: true, committedAt: true, rolledBackAt: true, lastError: true,
        actor: { select: { name: true } },
      },
    }),
  );

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader
          title="Bring a spreadsheet in"
          description="Tiny reads it, shows you what it will do, and does nothing until you agree"
          icon={<Upload />}
        />
        <div className="border-t border-hairline p-4">
          <SpreadsheetImport
            workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
            defaultWorkspaceId={workspaceId}
          />
        </div>
      </Panel>

      {batches.length > 0 ? (
        <Panel>
          <PanelHeader title="Import history" icon={<History />} />
          <div className="border-t border-hairline">
            <ImportHistory
              workspaceId={workspaceId ?? ""}
              batches={batches.map((b) => ({
                id: b.id,
                sourceName: b.sourceName,
                sheetName: b.sheetName,
                status: b.status,
                rowCount: b.rowCount,
                createdCount: b.createdCount,
                matchedCount: b.matchedCount,
                skippedCount: b.skippedCount,
                errorCount: b.errorCount,
                when: formatDate(b.committedAt ?? b.createdAt),
                who: b.actor?.name ?? "—",
                rolledBack: b.rolledBackAt != null,
                lastError: b.lastError,
              }))}
            />
          </div>
        </Panel>
      ) : null}

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
          title="Import contacts or companies"
          description="The older path, for a plain contact or company list"
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
