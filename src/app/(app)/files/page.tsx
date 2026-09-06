import Link from "next/link";
import { FileSpreadsheet, FileText, Image as ImageIcon, Paperclip, Presentation } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/empty-state";
import { CellStack, TBody, TD, TH, THead, TR, Table } from "@/components/ui/data-table";
import { FilterBar } from "@/components/app/filter-bar";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/dates";
import { scopedRead } from "@/lib/data/scoped";

export const metadata = { title: "Files" };

const ICONS: { test: RegExp; icon: typeof FileText }[] = [
  { test: /pdf|document|word/, icon: FileText },
  { test: /sheet|excel|csv/, icon: FileSpreadsheet },
  { test: /image|png|jpe?g|gif|svg/, icon: ImageIcon },
  { test: /presentation|powerpoint|slide/, icon: Presentation },
];

export default async function FilesPage({ searchParams }: PageProps<"/files">) {
  const params = await searchParams;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const q = typeof params.q === "string" ? params.q : undefined;

  const files = await scopedRead(workspaceIds, async () => {
    return db.fileAsset.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        ...(q ? { name: { contains: q } } : {}),
      },
      select: {
        id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true,
        uploader: { select: { name: true } },
        contact: { select: { id: true, fullName: true } },
        company: { select: { id: true, name: true } },
        deal: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        opportunity: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  return (
    <PageShell>
      <PageHeader
        title="Files"
        description="Proposals, contracts and RFP documents, attached to the record they belong to."
      />

      <div className="space-y-4">
        <FilterBar searchPlaceholder="Search files…" />

        <Panel>
          {files.length === 0 ? (
            <EmptyState
              icon={<Paperclip />}
              title="No files yet"
              description="Attach a proposal or contract from any project, deal, company or opportunity and it will be listed here."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH className="hidden md:table-cell">Attached to</TH>
                  <TH align="right" className="hidden sm:table-cell">Size</TH>
                  <TH className="hidden lg:table-cell">Added by</TH>
                  <TH>Added</TH>
                </tr>
              </THead>
              <TBody>
                {files.map((file) => {
                  const Icon = ICONS.find((entry) => entry.test.test(file.mimeType))?.icon ?? Paperclip;
                  const link =
                    (file.project && { href: `/projects/${file.project.id}`, label: file.project.name }) ||
                    (file.deal && { href: `/deals/${file.deal.id}`, label: file.deal.name }) ||
                    (file.company && { href: `/companies/${file.company.id}`, label: file.company.name }) ||
                    (file.opportunity && {
                      href: `/opportunities/${file.opportunity.id}`,
                      label: file.opportunity.name,
                    }) ||
                    (file.contact && { href: `/contacts/${file.contact.id}`, label: file.contact.fullName });

                  return (
                    <TR key={file.id}>
                      <TD>
                        <CellStack
                          leading={
                            <span className="flex size-8 items-center justify-center rounded-lg bg-sunken text-faint">
                              <Icon className="size-4" />
                            </span>
                          }
                          title={file.name}
                          subtitle={file.mimeType}
                        />
                      </TD>
                      <TD className="hidden md:table-cell">
                        {link ? (
                          <Link
                            href={link.href as never}
                            className="text-[13px] text-muted transition-colors hover:text-body hover:underline"
                          >
                            {link.label}
                          </Link>
                        ) : (
                          <span className="text-[13px] text-faint">—</span>
                        )}
                      </TD>
                      <TD align="right" className="hidden sm:table-cell">
                        <span className="text-[12.5px] tabular text-muted">{formatSize(file.sizeBytes)}</span>
                      </TD>
                      <TD className="hidden lg:table-cell">
                        <span className="text-[12.5px] text-muted">{file.uploader?.name ?? "—"}</span>
                      </TD>
                      <TD>
                        <span className="text-[12.5px] text-muted">{formatDay(file.createdAt)}</span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Panel>

        <p className="px-1 text-[12px] leading-relaxed text-faint">
          Files are addressed by a storage key rather than a URL, so local development writes to disk and
          production can point at S3 or R2 without touching the schema or any of these records.
        </p>
      </div>
    </PageShell>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
