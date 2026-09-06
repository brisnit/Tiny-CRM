"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  action, emptyToNull, logActivity, requireWorkspace, revalidateRecord,
} from "@/lib/actions/base";
import { htmlToText, truncate } from "@/lib/utils";

const noteSchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  title: emptyToNull,
  body: z.string().default(""),
  pinned: z.boolean().optional(),
  contactId: emptyToNull,
  companyId: emptyToNull,
  dealId: emptyToNull,
  projectId: emptyToNull,
  opportunityId: emptyToNull,
});

export async function createNote(input: z.input<typeof noteSchema>) {
  return action(async (user) => {
    const data = noteSchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);

    const plainText = htmlToText(data.body);
    const note = await db.note.create({
      data: {
        ...data,
        // Titles are optional; fall back to the first line so lists stay readable.
        title: data.title ?? (plainText ? truncate(plainText.split("\n")[0]!, 60) : null),
        plainText,
        authorId: user.id,
      },
    });

    await logActivity({
      workspaceId: data.workspaceId,
      actorId: user.id,
      type: "note",
      title: note.title ?? "Added a note",
      body: truncate(plainText, 200),
      noteId: note.id,
      contactId: note.contactId,
      companyId: note.companyId,
      dealId: note.dealId,
      projectId: note.projectId,
      opportunityId: note.opportunityId,
    });

    revalidateRecord(["/notes", "/contacts", "/companies", "/projects", "/deals"]);
    return { id: note.id, title: note.title };
  });
}

export async function updateNote(id: string, input: Partial<z.input<typeof noteSchema>>) {
  return action(async (user) => {
    const existing = await db.note.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = noteSchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const note = await db.note.update({
      where: { id },
      data: {
        ...data,
        plainText: data.body === undefined ? undefined : htmlToText(data.body),
      },
    });

    revalidateRecord(["/notes", `/notes/${id}`]);
    return { id: note.id };
  });
}

export async function deleteNote(id: string) {
  return action(async (user) => {
    const existing = await db.note.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId);
    await db.note.delete({ where: { id } });
    revalidateRecord(["/notes"]);
    return { id };
  });
}

export async function togglePinNote(id: string) {
  return action(async (user) => {
    const existing = await db.note.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, pinned: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);
    await db.note.update({ where: { id }, data: { pinned: !existing.pinned } });
    revalidateRecord(["/notes", `/notes/${id}`]);
    return { pinned: !existing.pinned };
  });
}

/**
 * Turns a note into a task, keeping every relationship the note carried. This
 * is the "capture now, organise later" path the product is built around.
 */
export async function convertNoteToTask(id: string, title?: string) {
  return action(async (user) => {
    const note = await db.note.findUniqueOrThrow({ where: { id } });
    await requireWorkspace(user.id, note.workspaceId);

    const task = await db.task.create({
      data: {
        workspaceId: note.workspaceId,
        title: title?.trim() || note.title || truncate(note.plainText.split("\n")[0] ?? "Follow up", 80),
        description: truncate(note.plainText, 500),
        ownerId: user.id,
        priority: "medium",
        contactId: note.contactId,
        companyId: note.companyId,
        dealId: note.dealId,
        projectId: note.projectId,
        opportunityId: note.opportunityId,
      },
    });

    revalidateRecord(["/tasks", "/notes", `/notes/${id}`]);
    return { id: task.id, title: task.title };
  });
}

export async function convertNoteToProject(id: string, name?: string) {
  return action(async (user) => {
    const note = await db.note.findUniqueOrThrow({ where: { id } });
    await requireWorkspace(user.id, note.workspaceId);

    const status = await db.projectStatus.findFirst({
      where: { workspaceId: note.workspaceId, key: "idea" },
      select: { id: true },
    });

    const project = await db.project.create({
      data: {
        workspaceId: note.workspaceId,
        name: name?.trim() || note.title || "New project",
        description: truncate(note.plainText, 1000),
        statusId: status?.id ?? null,
        companyId: note.companyId,
        ownerId: user.id,
        lastActivityAt: new Date(),
      },
    });

    await db.note.update({ where: { id }, data: { projectId: project.id } });

    revalidateRecord(["/projects", "/notes"]);
    return { id: project.id, name: project.name };
  });
}
