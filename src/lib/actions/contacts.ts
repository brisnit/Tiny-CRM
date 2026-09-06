"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { assertWithinLimit } from "@/lib/auth/session";
import {
  action, emptyToNull, logActivity, optionalDate, optionalInt, requireWorkspace, revalidateRecord,
} from "@/lib/actions/base";
import { LEAD_SOURCE, RELATIONSHIP_TYPE } from "@/lib/enums";
import { setTags } from "@/lib/actions/tags";

const contactSchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().default(""),
  jobTitle: emptyToNull,
  companyId: emptyToNull,
  email: z.string().trim().email("That email doesn't look right").or(z.literal("")).nullish(),
  phone: emptyToNull,
  website: emptyToNull,
  linkedin: emptyToNull,
  location: emptyToNull,
  relationshipType: z.enum(RELATIONSHIP_TYPE.values).default("prospect"),
  leadSource: z.enum(LEAD_SOURCE.values).nullish(),
  description: emptyToNull,
  importance: optionalInt,
  lastContactedAt: optionalDate,
  nextFollowUpAt: optionalDate,
  tags: z.array(z.string()).optional(),
});

export async function createContact(input: z.input<typeof contactSchema>) {
  return action(async (user) => {
    const data = contactSchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);
    await assertWithinLimit(user, "contacts");

    const contact = await db.contact.create({
      data: {
        workspaceId: data.workspaceId,
        firstName: data.firstName,
        lastName: data.lastName,
        fullName: `${data.firstName} ${data.lastName}`.trim(),
        jobTitle: data.jobTitle,
        companyId: data.companyId,
        email: data.email || null,
        phone: data.phone,
        website: data.website,
        linkedin: data.linkedin,
        location: data.location,
        relationshipType: data.relationshipType,
        leadSource: data.leadSource,
        description: data.description,
        importance: data.importance,
        lastContactedAt: data.lastContactedAt,
        nextFollowUpAt: data.nextFollowUpAt,
        ownerId: user.id,
      },
    });

    if (data.tags?.length) await setTags(data.workspaceId, "contact", contact.id, data.tags);

    await logActivity({
      workspaceId: data.workspaceId,
      actorId: user.id,
      type: "created",
      title: `Added ${contact.fullName}`,
      contactId: contact.id,
      companyId: contact.companyId,
    });

    revalidateRecord(["/contacts", "/companies"]);
    return { id: contact.id, name: contact.fullName };
  });
}

export async function updateContact(id: string, input: Partial<z.input<typeof contactSchema>>) {
  return action(async (user) => {
    const existing = await db.contact.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, fullName: true, firstName: true, lastName: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = contactSchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const firstName = data.firstName ?? existing.firstName;
    const lastName = data.lastName ?? existing.lastName;

    const contact = await db.contact.update({
      where: { id },
      data: {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`.trim(),
        jobTitle: data.jobTitle,
        companyId: data.companyId,
        email: data.email === undefined ? undefined : data.email || null,
        phone: data.phone,
        website: data.website,
        linkedin: data.linkedin,
        location: data.location,
        relationshipType: data.relationshipType,
        leadSource: data.leadSource,
        description: data.description,
        importance: data.importance,
        lastContactedAt: data.lastContactedAt,
        nextFollowUpAt: data.nextFollowUpAt,
      },
    });

    if (data.tags) await setTags(existing.workspaceId, "contact", id, data.tags);

    revalidateRecord(["/contacts", `/contacts/${id}`, "/companies"]);
    return { id: contact.id, name: contact.fullName };
  });
}

export async function deleteContact(id: string) {
  return action(async (user) => {
    const existing = await db.contact.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    });
    await requireWorkspace(user.id, existing.workspaceId, "manager");
    await db.contact.delete({ where: { id } });
    revalidateRecord(["/contacts", "/companies"]);
    return { id };
  });
}

/** Sets the next follow-up date — the single most-used contact action. */
export async function setFollowUp(id: string, date: string | null) {
  return action(async (user) => {
    const existing = await db.contact.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, fullName: true },
    });
    await requireWorkspace(user.id, existing.workspaceId);
    await db.contact.update({
      where: { id },
      data: { nextFollowUpAt: date ? new Date(date) : null },
    });
    revalidateRecord(["/contacts", `/contacts/${id}`]);
    return { id };
  });
}
