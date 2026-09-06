"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  assertVersion, audit, emitEvent, guard, logActivity, pickDefined, readWorkspaceId,
  recordAction, revalidateRecord, transaction, workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertRelations } from "@/lib/auth/access";
import { assertConfirmation } from "@/lib/destructive";
import { sanitizeHtml } from "@/lib/sanitize";
import { htmlToText, truncate } from "@/lib/utils";
import { LIMITS } from "@/lib/validation/limits";
import { zId, zOptionalId, zOptionalText, zRichText, zVersion } from "@/lib/validation/common";

/**
 * Notes are the one place users store arbitrary rich text, so they are the one
 * place stored XSS is a live risk.
 *
 * `body` is sanitised on **write**, through an allowlist, before it reaches the
 * database. Sanitising on render alone would leave the payload sitting in the
 * data — reachable by exports, AI context, search indexes and any future client
 * that renders it differently.
 */
const noteSchema = z.object({
  workspaceId: zId,
  title: zOptionalText(LIMITS.shortText),
  body: zRichText,
  pinned: z.boolean().optional(),
  contactId: zOptionalId,
  companyId: zOptionalId,
  dealId: zOptionalId,
  projectId: zOptionalId,
  opportunityId: zOptionalId,
});

const noteUpdateSchema = noteSchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type NoteInput = z.input<typeof noteSchema>;
type NoteUpdate = z.input<typeof noteUpdateSchema>;

const RELATIONS = ["contactId", "companyId", "dealId", "projectId", "opportunityId"] as const;

export async function createNote(
  input: NoteInput,
): Promise<ActionResult<{ id: string; title: string | null }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = noteSchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertRelations(workspaceId, relationsOf(data));

        const body = sanitizeHtml(data.body);
        const plainText = htmlToText(body);

        const note = await transaction(async (tx) => {
          const created = await tx.note.create({
            data: {
              workspaceId,
              // Titles are optional; fall back to the first line so lists stay readable.
              title: data.title ?? (plainText ? truncate(plainText.split("\n")[0]!, 60) : null),
              body,
              plainText,
              pinned: data.pinned ?? false,
              contactId: data.contactId ?? null,
              companyId: data.companyId ?? null,
              dealId: data.dealId ?? null,
              projectId: data.projectId ?? null,
              opportunityId: data.opportunityId ?? null,
              authorId: actor.identity.id,
            },
            select: {
              id: true, title: true, contactId: true, companyId: true,
              dealId: true, projectId: true, opportunityId: true,
            },
          });

          await logActivity(
            {
              workspaceId,
              actorId: actor.identity.id,
              type: "note",
              title: created.title ?? "Added a note",
              body: truncate(plainText, 200),
              noteId: created.id,
              contactId: created.contactId,
              companyId: created.companyId,
              dealId: created.dealId,
              projectId: created.projectId,
              opportunityId: created.opportunityId,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId, name: "note.created", entityType: "note",
              entityId: created.id, actorId: actor.identity.id,
            },
            tx,
          );

          return created;
        });

        revalidateRecord(["/notes", "/contacts", "/companies", "/projects", "/deals"]);
        return { id: note.id, title: note.title };
      },
    ),
  );
}

export async function updateNote(
  id: string,
  input: NoteUpdate,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("note", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const data = noteUpdateSchema.parse(input);

        await assertRelations(workspaceId, relationsOf(data));

        const body = data.body === undefined ? undefined : sanitizeHtml(data.body);

        const patch = {
          ...pickDefined(data, ["title", "pinned", ...RELATIONS]),
          ...(body === undefined ? {} : { body, plainText: htmlToText(body) }),
        };

        const result = await db.note.updateMany({
          where: {
            id: recordId, workspaceId,
            ...(data.version !== undefined ? { version: data.version } : {}),
          },
          data: { ...patch, version: { increment: 1 } },
        });
        assertVersion(result.count, data.version, "note");

        revalidateRecord(["/notes", `/notes/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function archiveNote(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("note", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        await db.note.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
        revalidateRecord(["/notes", `/notes/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

/**
 * Permanent note deletion.
 *
 * A note's whole value is its text, so this requires `record:delete` and — for
 * a titled note — the title retyped. Untitled scratch notes are deletable
 * without a confirmation string because there is nothing to type.
 */
export async function deleteNote(
  id: string,
  confirmation?: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("note", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const note = await db.note.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { title: true },
        });
        if (note.title) assertConfirmation(confirmation, note.title);

        await db.note.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId, action: "record.deleted", entityType: "note", entityId: recordId,
          summary: `Permanently deleted note ${note.title ?? "(untitled)"}`,
        });

        revalidateRecord(["/notes"]);
        return { id: recordId };
      },
    ),
  );
}

export async function togglePinNote(id: string): Promise<ActionResult<{ pinned: boolean }>> {
  return guard(() =>
    recordAction("note", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const note = await db.note.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { pinned: true },
        });
        await db.note.updateMany({
          where: { id: recordId, workspaceId },
          data: { pinned: !note.pinned, version: { increment: 1 } },
        });
        revalidateRecord(["/notes", `/notes/${recordId}`]);
        return { pinned: !note.pinned };
      },
    ),
  );
}

/**
 * Turns a note into a task, keeping every relationship the note carried. This
 * is the "capture now, organise later" path the product is built around.
 */
export async function convertNoteToTask(
  id: string,
  title?: string,
): Promise<ActionResult<{ id: string; title: string }>> {
  return guard(() =>
    recordAction("note", id, { permission: "record:create", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const requested = zOptionalText(LIMITS.shortText).parse(title ?? null);

        const note = await db.note.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            title: true, plainText: true, contactId: true, companyId: true,
            dealId: true, projectId: true, opportunityId: true,
          },
        });

        const task = await db.task.create({
          data: {
            workspaceId,
            title:
              requested ||
              note.title ||
              truncate(note.plainText.split("\n")[0] ?? "Follow up", 80),
            description: truncate(note.plainText, 500),
            ownerId: actor.identity.id,
            priority: "medium",
            contactId: note.contactId,
            companyId: note.companyId,
            dealId: note.dealId,
            projectId: note.projectId,
            opportunityId: note.opportunityId,
          },
          select: { id: true, title: true },
        });

        revalidateRecord(["/tasks", "/notes", `/notes/${recordId}`]);
        return { id: task.id, title: task.title };
      },
    ),
  );
}

export async function convertNoteToProject(
  id: string,
  name?: string,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("note", id, { permission: "record:create", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const requested = zOptionalText(LIMITS.shortText).parse(name ?? null);

        const note = await db.note.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { title: true, plainText: true, companyId: true },
        });

        const status = await db.projectStatus.findFirst({
          where: { workspaceId, key: "idea" },
          select: { id: true },
        });

        const project = await transaction(async (tx) => {
          const created = await tx.project.create({
            data: {
              workspaceId,
              name: requested || note.title || "New project",
              description: truncate(note.plainText, 1000),
              statusId: status?.id ?? null,
              companyId: note.companyId,
              ownerId: actor.identity.id,
              lastActivityAt: new Date(),
            },
            select: { id: true, name: true },
          });

          await tx.note.updateMany({
            where: { id: recordId, workspaceId },
            data: { projectId: created.id, version: { increment: 1 } },
          });

          await emitEvent(
            {
              workspaceId, name: "project.created", entityType: "project",
              entityId: created.id, actorId: actor.identity.id, payload: { fromNote: recordId },
            },
            tx,
          );

          return created;
        });

        revalidateRecord(["/projects", "/notes"]);
        return { id: project.id, name: project.name };
      },
    ),
  );
}

function relationsOf(data: Partial<Record<(typeof RELATIONS)[number], string | null | undefined>>) {
  return {
    contactId: data.contactId ?? null,
    companyId: data.companyId ?? null,
    dealId: data.dealId ?? null,
    projectId: data.projectId ?? null,
    opportunityId: data.opportunityId ?? null,
  };
}
