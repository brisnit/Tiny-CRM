import Link from "next/link";
import { Suspense } from "react";
import { Building2 } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { FilterBar, Pagination } from "@/components/app/filter-bar";
import { Panel, Skeleton } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { CellStack, TBody, TD, TH, THead, TR, Table } from "@/components/ui/data-table";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { listCompanies } from "@/lib/data/companies";
import { db } from "@/lib/db";
import { COMPANY_TYPE, RELATIONSHIP_STATUS } from "@/lib/enums";
import { formatCompact } from "@/lib/money";
import { timeAgo } from "@/lib/dates";

export const metadata = { title: "Companies" };

export default async function CompaniesPage({ searchParams }: PageProps<"/companies">) {
  return (
    <PageShell wide>
      <PageHeader
        title="Companies"
        description="Accounts, with every contact, deal and project attached."
        actions={<NewRecordButton kind="company" label="New company" />}
      />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <CompaniesTable searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function CompaniesTable({
  searchParams,
}: {
  searchParams: PageProps<"/companies">["searchParams"];
}) {
  const params = await searchParams;
  const actor = await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);

  const [{ companies, total, page, pageCount }, tags] = await Promise.all([
    listCompanies(workspaceIds, {
      q: str("q"),
      type: str("type"),
      relationshipStatus: str("relationshipStatus"),
      tag: str("tag"),
      view: str("view"),
      page: Number(str("page") ?? 1),
    }),
    db.tag.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { name: true },
      orderBy: { name: "asc" },
      take: 40,
    }),
  ]);

  return (
    <div className="space-y-4">
      <FilterBar
        searchPlaceholder="Search companies…"
        views={[
          { value: "all", label: "All" },
          { value: "clients", label: "Clients" },
          { value: "quiet", label: "Gone quiet" },
        ]}
        filters={[
          { key: "type", label: "Type", options: COMPANY_TYPE.options },
          { key: "relationshipStatus", label: "Status", options: RELATIONSHIP_STATUS.options },
          { key: "tag", label: "Tag", options: tags.map((t) => ({ value: t.name, label: t.name })) },
        ]}
      />

      <Panel>
        {companies.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title="No companies match"
            description="Companies pull a client's whole story together — contacts, deals, projects and history."
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <TH>Company</TH>
                  <TH className="hidden lg:table-cell">Industry</TH>
                  <TH className="hidden md:table-cell">Type</TH>
                  <TH align="right">Pipeline</TH>
                  <TH align="right" className="hidden sm:table-cell">People</TH>
                  <TH align="right" className="hidden lg:table-cell">Projects</TH>
                  <TH className="hidden xl:table-cell">Last activity</TH>
                </tr>
              </THead>
              <TBody>
                {companies.map((company) => (
                  <TR key={company.id} interactive>
                    <TD>
                      <Link href={`/companies/${company.id}`} className="block">
                        <CellStack
                          leading={<Avatar name={company.name} size="md" square />}
                          title={company.name}
                          subtitle={company.location ?? company.website ?? undefined}
                        />
                      </Link>
                    </TD>
                    <TD className="hidden lg:table-cell">
                      <span className="text-[13px] text-muted">{company.industry ?? "—"}</span>
                    </TD>
                    <TD className="hidden md:table-cell">
                      {company.type ? (
                        <Badge tone={COMPANY_TYPE.tone(company.type)}>{COMPANY_TYPE.label(company.type)}</Badge>
                      ) : (
                        <span className="text-[13px] text-faint">—</span>
                      )}
                    </TD>
                    <TD align="right">
                      <span className="text-[13px] font-medium tabular text-body">
                        {company.pipeline.value > 0 ? formatCompact(company.pipeline.value) : "—"}
                      </span>
                    </TD>
                    <TD align="right" className="hidden sm:table-cell">
                      <span className="text-[13px] text-muted tabular">{company._count.contacts || "—"}</span>
                    </TD>
                    <TD align="right" className="hidden lg:table-cell">
                      <span className="text-[13px] text-muted tabular">{company._count.projects || "—"}</span>
                    </TD>
                    <TD className="hidden xl:table-cell">
                      <span className="text-[12.5px] text-muted">{timeAgo(company.lastActivityAt)}</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageCount={pageCount} total={total} noun="company" />
          </>
        )}
      </Panel>
    </div>
  );
}
