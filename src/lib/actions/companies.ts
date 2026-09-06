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
import {
  COMPANY_SIZE, COMPANY_TYPE, LEAD_SOURCE, RELATIONSHIP_STATUS, REVENUE_RANGE,
} from "@/lib/enums";
import { setTags } from "@/lib/actions/tags";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zOptionalId, zOptionalText, zOptionalUrl, zShortText, zTags, zVersion,
} from "@/lib/validation/common";

const companySchema = z.object({
  workspaceId: zId,
  name: zShortText.min(1, "Company name is required"),
  domain: zOptionalText(LIMITS.shortText),
  website: zOptionalUrl,
  industry: zOptionalText(LIMITS.shortText),
  size: z.enum(COMPANY_SIZE.values).nullish(),
  location: zOptionalText(LIMITS.shortText),
  revenueRange: z.enum(REVENUE_RANGE.values).nullish(),
  type: z.enum(COMPANY_TYPE.values).nullish(),
  leadSource: z.enum(LEAD_SOURCE.values).nullish(),
  relationshipStatus: z.enum(RELATIONSHIP_STATUS.values).default("prospect"),
  description: zOptionalText(LIMITS.longText),
  primaryContactId: zOptionalId,
  tags: zTags,
});

const companyUpdateSchema = companySchema
  .omit({ workspaceId: true })
  .partial()
  .extend({ version: zVersion });

type CompanyInput = z.input<typeof companySchema>;
type CompanyUpdate = z.input<typeof companyUpdateSchema>;

const EDITABLE = [
  "name", "domain", "website", "industry", "size", "location", "revenueRange",
  "type", "leadSource", "relationshipStatus", "description", "primaryContactId",
] as const;

export async function createCompany(
  input: CompanyInput,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = companySchema.parse(input);
        const workspaceId = actor.workspaceId;

        await assertWithinLimit(actor, "companies");
        await assertRelations(workspaceId, { primaryContactId: data.primaryContactId ?? null });

        const company = await transaction(async (tx) => {
          const created = await tx.company.create({
            data: {
              workspaceId,
              name: data.name,
              // Derive the domain from the website so account matching works
              // later without asking the user for the same thing twice.
              domain: data.domain ?? domainFromUrl(data.website),
              website: data.website ?? null,
              industry: data.industry ?? null,
              size: data.size ?? null,
              location: data.location ?? null,
              revenueRange: data.revenueRange ?? null,
              type: data.type ?? null,
              leadSource: data.leadSource ?? null,
              relationshipStatus: data.relationshipStatus,
              description: data.description ?? null,
              primaryContactId: data.primaryContactId ?? null,
              ownerId: actor.identity.id,
            },
            select: { id: true, name: true },
          });

          await logActivity(
            {
              workspaceId,
              actorId: actor.identity.id,
              type: "created",
              title: `Added ${created.name}`,
              companyId: created.id,
            },
            tx,
          );

          await emitEvent(
            {
              workspaceId, name: "company.created", entityType: "company",
              entityId: created.id, actorId: actor.identity.id, payload: { name: created.name },
            },
            tx,
          );

          return created;
        });

        if (data.tags?.length) await setTags(workspaceId, "company", company.id, data.tags);

        await audit(actor, {
          workspaceId, action: "record.created", entityType: "company",
          entityId: company.id, summary: `Created company ${company.name}`,
        });

        revalidateRecord(["/companies", "/contacts"]);
        return { id: company.id, name: company.name };
      },
    ),
  );
}

export async function updateCompany(
  id: string,
  input: CompanyUpdate,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    recordAction("company", id, { permission: "record:edit", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = companyUpdateSchema.parse(input);

        const existing = await db.company.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: {
            name: true, domain: true, website: true, industry: true, size: true,
            location: true, type: true, relationshipStatus: true, primaryContactId: true,
          },
        });

        await assertRelations(workspaceId, { primaryContactId: data.primaryContactId ?? null });

        const patch = pickDefined(data, EDITABLE);

        const result = await db.company.updateMany({
          where: {
            id: recordId, workspaceId,
            ...(data.version !== undefined ? { version: data.version } : {}),
          },
          data: { ...patch, version: { increment: 1 } },
        });
        assertVersion(result.count, data.version, "company");

        if (data.tags) await setTags(workspaceId, "company", recordId, data.tags);

        const changes = diffFields(existing, patch, [
          "name", "domain", "website", "industry", "size", "location", "type",
          "relationshipStatus", "primaryContactId",
        ]);
        if (Object.keys(changes).length > 0) {
          await audit(actor, {
            workspaceId, action: "record.updated", entityType: "company",
            entityId: recordId, summary: `Updated company ${data.name ?? existing.name}`,
            metadata: changes,
          });
        }

        revalidateRecord(["/companies", `/companies/${recordId}`]);
        return { id: recordId, name: data.name ?? existing.name };
      },
    ),
  );
}

export async function archiveCompany(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("company", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.company.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.archived", entityType: "company",
          entityId: recordId, summary: "Archived a company",
        });
        revalidateRecord(["/companies", `/companies/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

export async function restoreCompany(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("company", id, { permission: "record:archive", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.company.updateMany({
          where: { id: recordId, workspaceId },
          data: { archivedAt: null, version: { increment: 1 } },
        });
        await audit(actor, {
          workspaceId, action: "record.restored", entityType: "company",
          entityId: recordId, summary: "Restored a company",
        });
        revalidateRecord(["/companies", `/companies/${recordId}`]);
        return { id: recordId };
      },
    ),
  );
}

/**
 * Irreversible deletion. Related contacts, deals, projects, tasks, notes,
 * activities and files are *detached* rather than destroyed — every foreign key
 * pointing at a company is `onDelete: SetNull`, so the record of what happened
 * outlives the record it happened to.
 */
export async function deleteCompany(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("company", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const company = await db.company.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { name: true },
        });
        assertConfirmation(confirmation, company.name);

        await db.company.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId, action: "record.deleted", entityType: "company",
          entityId: recordId, summary: `Permanently deleted company ${company.name}`,
        });

        revalidateRecord(["/companies", "/contacts"]);
        return { id: recordId };
      },
    ),
  );
}

function domainFromUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
