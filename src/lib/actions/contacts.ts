"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  assertVersion, audit, emitEvent, guard, logActivity, pickDefined, readWorkspaceId,
  recordAction, revalidateRecord, transaction, workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertRelations } from "@/lib/auth/access";
import { assertWithinLimit } from "@/lib/entitlements";
import { assertConfirmation } from "@/lib/destructive";
import { diffFields } from "@/lib/audit";
import { LEAD_SOURCE, RELATIONSHIP_TYPE } from "@/lib/enums";
import { setTags } from "@/lib/actions/tags";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zOptionalDate, zOptionalEmail, zOptionalId, zOptionalInt, zOptionalText,
  zOptionalUrl, zShortText, zTags, zVersion,
} from "@/lib/validation/common";

/**
 * Contact writes.
 *
 * Every action in this module follows the same four steps, in this order:
 *
 *   1. `workspaceAction` / `recordAction` authenticates the caller and proves
 *      membership and permission. A workspace id from the browser only ever
 *      *selects* among the caller's own memberships.
 *   2. Zod parses the payload inside that boundary. Unknown keys are stripped,
 *      which is what stops `ownerId`, `workspaceId` or `version` being assigned
 *      from a request.
 *   3. `assertRelations` proves every foreign key in the payload belongs to the
 *      same workspace, so a known id from another tenant cannot be attached.
 *   4. The write names its columns explicitly and is audited.
 */

const contactSchema = z.object({
  workspaceId: zId,
  firstName: zShortText.min(1, "First name is required"),
  lastName: zShortText.default(""),
  jobTitle: zOptionalText(LIMITS.shortText),
  companyId: zOptionalId,
  email: zOptionalEmail,
  phone: zOptionalText(LIMITS.shortText),
  website: zOptionalUrl,
  linkedin: zOptionalUrl,
  location: zOptionalText(LIMITS.shortText),
  relationshipType: z.enum(RELATIONSHIP_TYPE.values).default("prospect"),
  leadSource: z.enum(LEAD_SOURCE.values).nullish(),
  ownerId: zOptionalId,
  description: zOptionalText(LIMITS.longText),
  importance: zOptionalInt(0, 100),
  lastContactedAt: zOptionalDate,
  nextFollowUpAt: zOptionalDate,
  tags: zTags,
});

/**
 * The update schema omits `workspaceId` entirely rather than ignoring it. A
 * contact cannot be moved between tenants by any code path, so there is no
 * field to attack.
 */
const contactUpdateSchema = contactSchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type ContactInput = z.input<typeof contactSchema>;
type ContactUpdate = z.input<typeof contactUpdateSchema>;

const AUDITED_FIELDS = [
  "firstName", "lastName", "jobTitle", "companyId", "email", "phone",
  "relationshipType", "leadSource", "importance",
] as const;

export async function createContact(
  input: ContactInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = contactSchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertWithinLimit(actor, "contacts");
        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          // Membership-checked in assertRelations: a user who is not a member of
          // this workspace cannot be made the owner of one of its records.
          ownerId: data.ownerId ?? null,
        });

        const fullName = `${data.firstName} ${data.lastName}`.trim();

        const contact = await transaction(async (tx) => {
          const created = await tx.contact.create({
            data: {
              workspaceId,
              firstName: data.firstName,
              lastName: data.lastName,
              fullName,
              jobTitle: data.jobTitle ?? null,
              companyId: data.companyId ?? null,
              email: data.email ?? null,
              phone: data.phone ?? null,
              website: data.website ?? null,
              linkedin: data.linkedin ?? null,
              location: data.location ?? null,
              relationshipType: data.relationshipType,
              leadSource: data.leadSource ?? null,
              description: data.description ?? null,
              importance: data.importance ?? null,
              lastContactedAt: data.lastContactedAt ?? null,
              nextFollowUpAt: data.nextFollowUpAt ?? null,
              // Defaults to the creator. An explicit owner is allowed, but only
              // after assertRelations has confirmed they belong to this
              // workspace — an unchecked id here would hand the record to
              // someone outside the tenant.
              ownerId: data.ownerId ?? actor.identity.id,
            },
            select: { id: true, fullName: true, companyId: true },
          });

          await logActivity(
            {
              workspaceId,
              actorId: actor.identity.id,
              type: "created",
              title: `Added ${created.fullName}`,
              contactId: created.id,
              companyId: created.companyId,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId,
              name: "contact.created",
              entityType: "contact",
              entityId: created.id,
              actorId: actor.identity.id,
              payload: { name: created.fullName },
            },
            tx,
          );

          return created;
        });

        if (data.tags?.length) await setTags(workspaceId, "contact", contact.id, data.tags);

        await audit(actor, {
          workspaceId,
          action: "record.created",
          entityType: "contact",
          entityId: contact.id,
          summary: `Created contact ${contact.fullName}`,
        });

        revalidateRecord(["/contacts", "/companies"]);
        return { id: contact.id, name: contact.fullName };
      },
    ),
  );
}

export async function updateContact(
  id: string,
  input: ContactUpdate,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("contact", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = contactUpdateSchema.parse(input);

        const existing = await db.contact.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            firstName: true, lastName: true, jobTitle: true, companyId: true, email: true,
            phone: true, relationshipType: true, leadSource: true, importance: true,
          },
        });

        await assertRelations(workspaceId, {
          companyId: data.companyId ?? null,
          // Membership-checked in assertRelations: a user who is not a member of
          // this workspace cannot be made the owner of one of its records.
          ownerId: data.ownerId ?? null,
        });

        const firstName = data.firstName ?? existing.firstName;
        const lastName = data.lastName ?? existing.lastName;

        // Only keys actually present in the payload are written, so a partial
        // form does not blank the fields it did not render.
        const patch = {
          ...(data.firstName !== undefined || data.lastName !== undefined
            ? { firstName, lastName, fullName: `${firstName} ${lastName}`.trim() }
            : {}),
          ...pickDefined(data, [
            "jobTitle", "companyId", "email", "phone", "website", "linkedin", "location",
            "relationshipType", "leadSource", "description", "importance",
            "lastContactedAt", "nextFollowUpAt", "ownerId",
          ]),
        };

        // The expected version travels in the WHERE clause: a concurrent save
        // makes this match zero rows rather than silently winning.
        const result = await db.contact.updateMany({
          where: { id: recordId, workspaceId, ...(data.version !== undefined ? { version: data.version } : {}) },
          data: { ...patch, version: { increment: 1 } },
        });
        assertVersion(result.count, data.version, "contact");

        if (data.tags) await setTags(workspaceId, "contact", recordId, data.tags);

        const changes = diffFields(existing, patch, [...AUDITED_FIELDS]);
        if (Object.keys(changes).length > 0) {
          await audit(actor, {
            workspaceId,
            action: "record.updated",
            entityType: "contact",
            entityId: recordId,
            summary: `Updated contact ${firstName} ${lastName}`.trim(),
            metadata: changes,
          });
        }

        revalidateRecord(["/contacts", `/contacts/${recordId}`, "/companies"]);
        return { id: recordId, name: `${firstName} ${lastName}`.trim() };
      },
    ),
  );
}

/** Reversible removal. This is what "delete" means in the UI. */
export async function archiveContact(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("contact", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await transaction(async (tx) => {
          await tx.contact.updateMany({
            where: { id: recordId, workspaceId },
            data: { archivedAt: new Date(), version: { increment: 1 } },
          });
          await emitEvent(
            {
              workspaceId, name: "contact.archived", entityType: "contact",
              entityId: recordId, actorId: actor.identity.id,
            },
            tx,
          );
        });

        await audit(actor, {
          workspaceId, action: "record.archived", entityType: "contact",
          entityId: recordId, summary: "Archived a contact",
        });

        revalidateRecord(["/contacts", `/contacts/${recordId}`, "/companies"]);
        return { id: recordId };
      },
    ),
  );
}

export async function restoreContact(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("contact", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.contact.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: null, version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.restored", entityType: "contact",
          entityId: recordId, summary: "Restored a contact",
        });
        revalidateRecord(["/contacts", `/contacts/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

/**
 * Irreversible deletion.
 *
 * Requires `record:delete` (not granted to members) *and* the record's name
 * retyped. The typed confirmation is verified here rather than in the dialog,
 * because a direct call to this action would skip any client-side check.
 *
 * Related activity, files, tasks and notes are detached (`onDelete: SetNull`)
 * rather than destroyed — the history of what happened survives the record.
 */
export async function deleteContact(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("contact", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const contact = await db.contact.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { fullName: true, email: true },
        });

        assertConfirmation(confirmation, contact.fullName);

        await db.contact.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId,
          action: "record.deleted",
          entityType: "contact",
          entityId: recordId,
          summary: `Permanently deleted contact ${contact.fullName}`,
          metadata: { email: contact.email },
        });

        revalidateRecord(["/contacts", "/companies"]);
        return { id: recordId };
      },
    ),
  );
}

/** Sets the next follow-up date — the single most-used contact action. */
export async function setFollowUp(
  id: string,
  date: string | null,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("contact", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const nextFollowUpAt = zOptionalDate.parse(date) ?? null;
        await db.contact.updateMany({
          where: { id: recordId, workspaceId },
          data: { nextFollowUpAt, version: { increment: 1 } },
        });
        revalidateRecord(["/contacts", `/contacts/${recordId}`, "/home"]);
        return { id: recordId };
      },
    ),
  );
}
