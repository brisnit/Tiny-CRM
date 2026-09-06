import Link from "next/link";
import { Suspense } from "react";
import { Users } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { FilterBar, Pagination } from "@/components/app/filter-bar";
import { Panel, Skeleton } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { CellStack, TBody, TD, TH, THead, TR, Table } from "@/components/ui/data-table";
import { NewRecordButton } from "@/components/app/new-record-button";
import { requireUser, resolveScope } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { listContacts } from "@/lib/data/contacts";
import { db } from "@/lib/db";
import { RELATIONSHIP_STRENGTH, RELATIONSHIP_TYPE } from "@/lib/enums";
import { formatDay, daysSince } from "@/lib/dates";

export const metadata = { title: "Contacts" };

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  return (
    <PageShell wide>
      <PageHeader
        title="Contacts"
        description="Everyone you work with, and how warm each relationship actually is."
        actions={<NewRecordButton kind="contact" label="New contact" />}
      />
      <Suspense fallback={<ListSkeleton />}>
        <ContactsTable searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function ContactsTable({
  searchParams,
}: {
  searchParams: PageProps<"/contacts">["searchParams"];
}) {
  const params = await searchParams;
  const user = await requireUser();
  const { workspaceIds } = await resolveScope(user.id, await readScope());

  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);

  const [{ contacts, total, page, pageCount }, tags] = await Promise.all([
    listContacts(workspaceIds, {
      q: str("q"),
      relationshipType: str("relationshipType"),
      tag: str("tag"),
      view: (str("view") as never) ?? "all",
      sort: (str("sort") as never) ?? "recent",
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
        searchPlaceholder="Search name, email or company…"
        views={[
          { value: "all", label: "All" },
          { value: "follow_up", label: "Needs follow-up" },
          { value: "quiet", label: "Gone quiet" },
          { value: "clients", label: "Clients" },
          { value: "new", label: "Recently added" },
        ]}
        filters={[
          { key: "relationshipType", label: "Relationship", options: RELATIONSHIP_TYPE.options },
          { key: "tag", label: "Tag", options: tags.map((t) => ({ value: t.name, label: t.name })) },
          {
            key: "sort",
            label: "Sort",
            options: [
              { value: "recent", label: "Recently updated" },
              { value: "name", label: "Name (A–Z)" },
              { value: "oldest_contact", label: "Longest since contact" },
              { value: "follow_up", label: "Follow-up date" },
            ],
          },
        ]}
      />

      <Panel>
        {contacts.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No contacts match"
            description="A CRM is only as good as the people in it. Add someone, or clear the filters."
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH className="hidden md:table-cell">Company</TH>
                  <TH className="hidden lg:table-cell">Relationship</TH>
                  <TH>Strength</TH>
                  <TH className="hidden sm:table-cell">Last contact</TH>
                  <TH className="hidden xl:table-cell">Follow-up</TH>
                  <TH align="right" className="hidden lg:table-cell">Open</TH>
                </tr>
              </THead>
              <TBody>
                {contacts.map((contact) => {
                  const since = daysSince(contact.lastContactedAt);
                  const overdue = contact.nextFollowUpAt && contact.nextFollowUpAt < new Date();
                  return (
                    <TR key={contact.id} interactive>
                      <TD>
                        <Link href={`/contacts/${contact.id}`} className="block">
                          <CellStack
                            leading={<Avatar name={contact.fullName} size="md" />}
                            title={contact.fullName}
                            subtitle={contact.jobTitle ?? contact.email ?? undefined}
                          />
                        </Link>
                      </TD>
                      <TD className="hidden md:table-cell">
                        {contact.company ? (
                          <Link
                            href={`/companies/${contact.company.id}`}
                            className="text-[13px] text-muted transition-colors hover:text-body hover:underline"
                          >
                            {contact.company.name}
                          </Link>
                        ) : (
                          <span className="text-[13px] text-faint">—</span>
                        )}
                      </TD>
                      <TD className="hidden lg:table-cell">
                        <Badge tone={RELATIONSHIP_TYPE.tone(contact.relationshipType)}>
                          {RELATIONSHIP_TYPE.label(contact.relationshipType)}
                        </Badge>
                      </TD>
                      <TD>
                        <span title={contact.relationship.summary}>
                          <Badge tone={RELATIONSHIP_STRENGTH.tone(contact.relationship.value)}>
                            {RELATIONSHIP_STRENGTH.label(contact.relationship.value)}
                          </Badge>
                        </span>
                      </TD>
                      <TD className="hidden sm:table-cell">
                        <span className="text-[12.5px] text-muted tabular">
                          {since === null ? "Never" : since === 0 ? "Today" : `${since}d ago`}
                        </span>
                      </TD>
                      <TD className="hidden xl:table-cell">
                        {contact.nextFollowUpAt ? (
                          <span
                            className={`text-[12.5px] tabular ${overdue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted"}`}
                          >
                            {formatDay(contact.nextFollowUpAt)}
                          </span>
                        ) : (
                          <span className="text-[12.5px] text-faint">—</span>
                        )}
                      </TD>
                      <TD align="right" className="hidden lg:table-cell">
                        <span className="text-[12.5px] text-muted tabular">
                          {contact._count.deals + contact._count.projects || "—"}
                        </span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageCount={pageCount} total={total} noun="contact" />
          </>
        )}
      </Panel>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-full max-w-md" />
      <Panel>
        <div className="divide-y divide-hairline">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-2.5 w-24" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
