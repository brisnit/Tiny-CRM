import Link from "next/link";
import { Suspense } from "react";
import { FileText, Pin } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { FilterBar } from "@/components/app/filter-bar";
import { Panel, Skeleton } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/empty-state";
import { NewRecordButton } from "@/components/app/new-record-button";
import { CaptureWithAi } from "@/components/app/capture-with-ai";
import { requireUser, resolveScope } from "@/lib/auth/session";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { formatDay, timeAgo } from "@/lib/dates";
import { truncate } from "@/lib/utils";

export const metadata = { title: "Notes" };

export default async function NotesPage({ searchParams }: PageProps<"/notes">) {
  return (
    <PageShell>
      <PageHeader
        title="Notes"
        description="Capture anything. Tiny AI can turn it into contacts, companies and tasks."
        actions={<NewRecordButton kind="note" label="New note" />}
      />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <NotesList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function NotesList({ searchParams }: { searchParams: PageProps<"/notes">["searchParams"] }) {
  const params = await searchParams;
  const user = await requireUser();
  const { workspaceIds, workspaceId } = await resolveScope(user.id, await readScope());
  const str = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);

  const where: Record<string, unknown> = { workspaceId: { in: workspaceIds } };
  if (str("q")) {
    where.OR = [{ title: { contains: str("q") } }, { plainText: { contains: str("q") } }];
  }
  if (str("view") === "pinned") where.pinned = true;

  const notes = await db.note.findMany({
    where,
    select: {
      id: true, title: true, plainText: true, pinned: true, createdAt: true, updatedAt: true,
      contact: { select: { id: true, fullName: true } },
      company: { select: { id: true, name: true } },
      deal: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
      opportunity: { select: { id: true, name: true } },
    },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    take: 100,
  });

  return (
    <div className="space-y-4">
      <CaptureWithAi
        workspaceId={workspaceId}
        workspaces={(await db.workspace.findMany({
          where: { id: { in: workspaceIds } },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        }))}
      />

      <FilterBar
        searchPlaceholder="Search notes…"
        views={[
          { value: "all", label: "All" },
          { value: "pinned", label: "Pinned" },
        ]}
      />

      {notes.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<FileText />}
            title="Nothing captured yet"
            description="Paste a call summary above and Tiny AI will pull out the people, companies and next steps."
          />
        </Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {notes.map((note) => {
            const links = [
              note.contact && { href: `/contacts/${note.contact.id}`, label: note.contact.fullName },
              note.company && { href: `/companies/${note.company.id}`, label: note.company.name },
              note.deal && { href: `/deals/${note.deal.id}`, label: note.deal.name },
              note.project && { href: `/projects/${note.project.id}`, label: note.project.name },
              note.opportunity && { href: `/opportunities/${note.opportunity.id}`, label: note.opportunity.name },
            ].filter(Boolean as unknown as (v: unknown) => v is { href: string; label: string });

            return (
              <Link
                key={note.id}
                href={`/notes/${note.id}`}
                className="flex flex-col rounded-xl border border-hairline bg-panel p-4 transition-colors hover:border-hairline-strong"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-[13.5px] font-semibold tracking-[-0.01em] text-body">
                    {note.title ?? "Untitled note"}
                  </h3>
                  {note.pinned ? <Pin className="size-3.5 shrink-0 text-brand-500" /> : null}
                </div>
                <p className="mt-2 line-clamp-4 flex-1 text-[12.5px] leading-relaxed text-muted">
                  {truncate(note.plainText, 260)}
                </p>
                {links.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {links.slice(0, 3).map((link) => (
                      <span
                        key={link.href}
                        className="max-w-[10rem] truncate rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted"
                      >
                        {link.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="mt-3 border-t border-hairline pt-2.5 text-[11px] text-faint">
                  {formatDay(note.createdAt)} · updated {timeAgo(note.updatedAt)}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
