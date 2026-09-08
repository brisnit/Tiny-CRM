"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  assertVersion, audit, emitEvent, guard, logActivity, pickDefined, readWorkspaceId,
  recordAction, revalidateRecord, transaction, workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertRelations } from "@/lib/auth/access";
import { noSuchRecord } from "@/lib/errors";
import { assertWithinLimit } from "@/lib/entitlements";
import { assertConfirmation } from "@/lib/destructive";
import { diffFields } from "@/lib/audit";
import { dispatchSoon } from "@/lib/events";
import { PROJECT_PRIORITY, PROJECT_TYPE } from "@/lib/enums";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zOptionalDate, zOptionalId, zOptionalMoney, zOptionalText, zShortText, zVersion,
} from "@/lib/validation/common";

const projectSchema = z.object({
  workspaceId: zId,
  name: zShortText.min(1, "Give the project a name"),
  companyId: zOptionalId,
  statusId: zOptionalId,
  type: z.enum(PROJECT_TYPE.values).nullish(),
  description: zOptionalText(LIMITS.longText),
  priority: z.enum(PROJECT_PRIORITY.values).default("medium"),
  startDate: zOptionalDate,
  targetDate: zOptionalDate,
  budgetCents: zOptionalMoney,
  revenueCents: zOptionalMoney,
  nextAction: zOptionalText(LIMITS.mediumText),
  nextActionDueAt: zOptionalDate,
});

const projectUpdateSchema = projectSchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type ProjectInput = z.input<typeof projectSchema>;
type ProjectUpdate = z.input<typeof projectUpdateSchema>;

const EDITABLE = [
  "name", "companyId", "statusId", "type", "description", "priority",
  "startDate", "targetDate", "budgetCents", "revenueCents", "nextAction", "nextActionDueAt",
] as const;

export async function createProject(
  input: ProjectInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = projectSchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertWithinLimit(actor, "projects");
        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          statusId: data.statusId ?? null,
        });

        // Fall back to the workspace's default status so a project always has a
        // home — and the fallback is looked up *within* the workspace.
        const statusId =
          data.statusId ??
          (
            await db.projectStatus.findFirst({
              where: { workspaceId, isDefault: true },
              select: { id: true },
            })
          )?.id ??
          null;

        const project = await transaction(async (tx) => {
          const created = await tx.project.create({
            data: {
              workspaceId,
              name: data.name,
              companyId: data.companyId ?? null,
              statusId,
              type: data.type ?? null,
              description: data.description ?? null,
              priority: data.priority,
              startDate: data.startDate ?? null,
              targetDate: data.targetDate ?? null,
              budgetCents: data.budgetCents ?? null,
              revenueCents: data.revenueCents ?? null,
              nextAction: data.nextAction ?? null,
              nextActionDueAt: data.nextActionDueAt ?? null,
              ownerId: actor.identity.id,
              lastActivityAt: new Date(),
            },
            select: { id: true, name: true, companyId: true },
          });

          await logActivity(
            {
              workspaceId, actorId: actor.identity.id, type: "created",
              title: `Started ${created.name}`, projectId: created.id, companyId: created.companyId,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId, name: "project.created", entityType: "project",
              entityId: created.id, actorId: actor.identity.id, payload: { name: created.name },
            },
            tx,
          );

          return created;
        });

        await audit(actor, {
          workspaceId, action: "record.created", entityType: "project",
          entityId: project.id, summary: `Created project ${project.name}`,
        });

        dispatchSoon();
        revalidateRecord(["/projects", "/companies"]);
        return { id: project.id, name: project.name };
      },
    ),
  );
}

export async function updateProject(
  id: string,
  input: ProjectUpdate,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("project", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = projectUpdateSchema.parse(input);

        const existing = await db.project.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            name: true, statusId: true, companyId: true, priority: true,
            targetDate: true, budgetCents: true, revenueCents: true,
          },
        });

        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          statusId: data.statusId ?? null,
        });

        const statusChanged = Boolean(data.statusId && data.statusId !== existing.statusId);
        const status = statusChanged
          ? await db.projectStatus.findFirstOrThrow({
              where: { id: data.statusId!, workspaceId },
              select: { name: true, key: true, isTerminal: true },
            })
          : null;

        const patch = pickDefined(data, EDITABLE);

        const result = await db.project.updateMany({
          where: {
            id: recordId, workspaceId,
            ...(data.version !== undefined ? { version: data.version } : {}),
          },
          data: {
            ...patch,
            ...(status
              ? { completedAt: status.isTerminal ? new Date() : null, lastActivityAt: new Date() }
              : {}),
            version: { increment: 1 },
          },
        });
        assertVersion(result.count, data.version, "project");

        if (status) {
          await transaction(async (tx) => {
            await logActivity(
              {
                workspaceId, actorId: actor.identity.id, type: "project_update",
                title: `Status changed to ${status.name}`,
                meta: { statusKey: status.key }, projectId: recordId,
              },
              tx,
            );
            await emitEvent(
              {
                workspaceId, name: "project.status.changed", entityType: "project",
                entityId: recordId, actorId: actor.identity.id,
                payload: {
                  statusKey: status.key, statusName: status.name,
                  projectName: data.name ?? existing.name,
                },
              },
              tx,
            );
          });
        }

        const changes = diffFields(existing, patch, [
          "name", "statusId", "companyId", "priority", "targetDate", "budgetCents", "revenueCents",
        ]);
        if (Object.keys(changes).length > 0) {
          await audit(actor, {
            workspaceId, action: "record.updated", entityType: "project", entityId: recordId,
            summary: `Updated project ${data.name ?? existing.name}`, metadata: changes,
          });
        }

        dispatchSoon();
        revalidateRecord(["/projects", `/projects/${recordId}`]);
        return { id: recordId, name: data.name ?? existing.name };
      },
    ),
  );
}

export async function archiveProject(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("project", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.project.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.archived", entityType: "project",
          entityId: recordId, summary: "Archived a project",
        });
        revalidateRecord(["/projects", `/projects/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function restoreProject(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("project", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.project.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: null, version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.restored", entityType: "project",
          entityId: recordId, summary: "Restored a project",
        });
        revalidateRecord(["/projects", `/projects/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function deleteProject(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("project", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const project = await db.project.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { name: true },
        });
        assertConfirmation(confirmation, project.name);

        await db.project.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId, action: "record.deleted", entityType: "project", entityId: recordId,
          summary: `Permanently deleted project ${project.name}`,
        });

        revalidateRecord(["/projects"]);
        return { id: recordId };
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Milestones
//
// A milestone has no workspaceId of its own; it is reached through its project,
// which is why "milestone" is a scoped model with a join in requireRecordAccess.
// ---------------------------------------------------------------------------

export async function toggleMilestone(id: string): Promise<ActionResult<{ id: string; done: boolean }>> {
  return guard(() =>
    recordAction("milestone", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const milestone = await db.milestone.findFirstOrThrow({
          where: { id: recordId, project: { workspaceId } },
          select: { completedAt: true, name: true, projectId: true },
        });

        const done = Boolean(milestone.completedAt);
        await db.milestone.updateMany({
          where: { id: recordId, project: { workspaceId } },
          data: { completedAt: done ? null : new Date() },
        });

        if (!done) {
          await logActivity({
            workspaceId, actorId: actor.identity.id, type: "project_update",
            title: `Milestone complete: ${milestone.name}`, projectId: milestone.projectId,
          });
        }

        revalidateRecord([`/projects/${milestone.projectId}`, "/projects"]);
        return { id: recordId, done: !done };
      },
    ),
  );
}

export async function addMilestone(
  projectId: string,
  name: string,
  dueDate?: string | null,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("project", projectId, { permission: "record:edit", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const parsed = z
          .object({ name: zShortText.min(1, "Give the milestone a name"), dueDate: zOptionalDate })
          .parse({ name, dueDate });

        const count = await db.milestone.count({ where: { projectId: recordId } });
        const milestone = await db.milestone.create({
          data: {
            projectId: recordId,
            name: parsed.name,
            order: count,
            dueDate: parsed.dueDate ?? null,
          },
          select: { id: true },
        });

        void workspaceId;
        revalidateRecord([`/projects/${recordId}`]);
        return { id: milestone.id };
      },
    ),
  );
}

export async function setProjectNextAction(
  id: string,
  nextAction: string,
  dueAt?: string | null,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("project", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const parsed = z
          .object({ nextAction: zOptionalText(LIMITS.mediumText), dueAt: zOptionalDate })
          .parse({ nextAction, dueAt });

        await db.project.updateMany({
          where: { id: recordId, workspaceId },
          data: {
            nextAction: parsed.nextAction ?? null,
            nextActionDueAt: parsed.dueAt ?? null,
            lastActivityAt: new Date(),
            version: { increment: 1 },
          },
        });

        revalidateRecord([`/projects/${recordId}`, "/projects", "/home"]);
        return { id: recordId };
      },
    ),
  );
}

/**
 * Attaches a person to a project, or detaches them.
 *
 * `ProjectContact` existed in the schema from the start and nothing ever wrote
 * to it. The consequence was the most visible gap in the product: a project
 * page shows a People panel that says "Add the client contacts and
 * collaborators on this project", and there was no way to add one. Project
 * Intelligence is meant to answer "who is involved", and it could only ever
 * answer "nobody".
 *
 * The contact is looked up inside the project's own workspace, so a contact id
 * from another tenant resolves to nothing and is refused as a missing record —
 * the same shape every other cross-tenant reference gets, and not a distinct
 * error that would confirm the id exists somewhere.
 */
export async function setProjectContact(
  projectId: string,
  contactId: string,
  attached: boolean,
): Promise<ActionResult<{ contactId: string; attached: boolean }>> {
  return guard(() =>
    recordAction("project", projectId, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const id = zId.parse(contactId);

        const contact = await db.contact.findFirst({
          where: { id, workspaceId },
          select: { id: true, fullName: true },
        });
        if (!contact) throw noSuchRecord();

        if (attached) {
          await db.projectContact.upsert({
            where: { projectId_contactId: { projectId: recordId, contactId: contact.id } },
            update: {},
            create: { projectId: recordId, contactId: contact.id },
          });
        } else {
          await db.projectContact.deleteMany({ where: { projectId: recordId, contactId: contact.id } });
        }

        await audit(actor, {
          workspaceId,
          action: "record.updated",
          entityType: "project",
          entityId: recordId,
          summary: `${attached ? "Added" : "Removed"} ${contact.fullName} ${attached ? "to" : "from"} the project`,
        });

        revalidateRecord([`/projects/${recordId}`]);
        return { contactId: contact.id, attached };
      },
    ),
  );
}
