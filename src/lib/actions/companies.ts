"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { assertWithinLimit } from "@/lib/auth/session";
import { action, emptyToNull, logActivity, requireWorkspace, revalidateRecord } from "@/lib/actions/base";
import { COMPANY_SIZE, COMPANY_TYPE, LEAD_SOURCE, RELATIONSHIP_STATUS, REVENUE_RANGE } from "@/lib/enums";
import { setTags } from "@/lib/actions/tags";

const companySchema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace"),
  name: z.string().trim().min(1, "Company name is required"),
  domain: emptyToNull,
  website: emptyToNull,
  industry: emptyToNull,
  size: z.enum(COMPANY_SIZE.values).nullish(),
  location: emptyToNull,
  revenueRange: z.enum(REVENUE_RANGE.values).nullish(),
  type: z.enum(COMPANY_TYPE.values).nullish(),
  leadSource: z.enum(LEAD_SOURCE.values).nullish(),
  relationshipStatus: z.enum(RELATIONSHIP_STATUS.values).default("prospect"),
  description: emptyToNull,
  primaryContactId: emptyToNull,
  tags: z.array(z.string()).optional(),
});

export async function createCompany(input: z.input<typeof companySchema>) {
  return action(async (user) => {
    const data = companySchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);
    await assertWithinLimit(user, "companies");

    const company = await db.company.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        // Derive the domain from the website so account matching works later
        // without asking the user for the same thing twice.
        domain: data.domain ?? domainFromUrl(data.website),
        website: data.website,
        industry: data.industry,
        size: data.size,
        location: data.location,
        revenueRange: data.revenueRange,
        type: data.type,
        leadSource: data.leadSource,
        relationshipStatus: data.relationshipStatus,
        description: data.description,
        ownerId: user.id,
      },
    });

    if (data.tags?.length) await setTags(data.workspaceId, "company", company.id, data.tags);

    await logActivity({
      workspaceId: data.workspaceId,
      actorId: user.id,
      type: "created",
      title: `Added ${company.name}`,
      companyId: company.id,
    });

    revalidateRecord(["/companies", "/contacts"]);
    return { id: company.id, name: company.name };
  });
}

export async function updateCompany(id: string, input: Partial<z.input<typeof companySchema>>) {
  return action(async (user) => {
    const existing = await db.company.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId);

    const data = companySchema.partial().parse({ ...input, workspaceId: existing.workspaceId });
    const company = await db.company.update({
      where: { id },
      data: {
        name: data.name,
        domain: data.domain,
        website: data.website,
        industry: data.industry,
        size: data.size,
        location: data.location,
        revenueRange: data.revenueRange,
        type: data.type,
        leadSource: data.leadSource,
        relationshipStatus: data.relationshipStatus,
        description: data.description,
        primaryContactId: data.primaryContactId,
      },
    });

    if (data.tags) await setTags(existing.workspaceId, "company", id, data.tags);

    revalidateRecord(["/companies", `/companies/${id}`]);
    return { id: company.id, name: company.name };
  });
}

export async function deleteCompany(id: string) {
  return action(async (user) => {
    const existing = await db.company.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId, "manager");
    await db.company.delete({ where: { id } });
    revalidateRecord(["/companies"]);
    return { id };
  });
}

function domainFromUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
