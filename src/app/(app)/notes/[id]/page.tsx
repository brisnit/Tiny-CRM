import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel } from "@/components/ui/surface";
import { Badge } from "@/components/ui/badge";
import { NoteEditor } from "@/components/app/note-editor";
import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/dates";
import { tagsForEntities } from "@/lib/actions/tags";

export async function generateMetadata({ params }: PageProps<"/notes/[id]">) {
  const { id } = await params;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());
  const note = await db.note.findFirst({
    where: { id, workspaceId: { in: workspaceIds } },
    select: { title: true },
  });
  return { title: note?.title ?? "Note" };
}

export default async function NotePage({ params }: PageProps<"/notes/[id]">) {
  const { id } = await params;
  await requireActor();
  const { workspaceIds } = await resolveReadScope(await readScope());

  const note = await db.note.findFirst({
    where: { id, workspaceId: { in: workspaceIds } },
    include: {
      author: { select: { name: true } },
      workspace: { select: { name: true } },
      contact: { select: { id: true, fullName: true } },
      company: { select: { id: true, name: true } },
      deal: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
      opportunity: { select: { id: true, name: true } },
    },
  });
  if (!note) notFound();

  const tags = (await tagsForEntities("note", [id])).get(id) ?? [];

  const links = [
    note.contact && { href: `/contacts/${note.contact.id}`, label: note.contact.fullName, kind: "Contact" },
    note.company && { href: `/companies/${note.company.id}`, label: note.company.name, kind: "Company" },
    note.deal && { href: `/deals/${note.deal.id}`, label: note.deal.name, kind: "Deal" },
    note.project && { href: `/projects/${note.project.id}`, label: note.project.name, kind: "Project" },
    note.opportunity && {
      href: `/opportunities/${note.opportunity.id}`,
      label: note.opportunity.name,
      kind: "Opportunity",
    },
  ].filter(Boolean as unknown as (v: unknown) => v is { href: string; label: string; kind: string });

  return (
    <PageShell className="max-w-4xl">
      <PageHeader
        backHref="/notes"
        backLabel="Notes"
        eyebrow={note.workspace.name}
        title={note.title ?? "Untitled note"}
        meta={
          <>
            <span className="text-[12px] text-faint">
              {note.author?.name ? `${note.author.name} · ` : ""}
              {formatDateTime(note.createdAt)}
            </span>
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href as never}
                className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hairline hover:text-body"
              >
                {link.kind}: {link.label}
              </Link>
            ))}
            {tags.map((tag) => (
              <Badge key={tag.name} dot={tag.color}>
                {tag.name}
              </Badge>
            ))}
          </>
        }
      />

      <Panel>
        <NoteEditor
          noteId={note.id}
          title={note.title}
          body={note.body}
          pinned={note.pinned}
        />
      </Panel>
    </PageShell>
  );
}
