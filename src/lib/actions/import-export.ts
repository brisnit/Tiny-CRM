"use server";

import { db } from "@/lib/db";
import { action, requireWorkspace, revalidateRecord } from "@/lib/actions/base";
import { assertWithinLimit, resolveScope } from "@/lib/auth/session";
import { matchColumn, parseCsv, toCsv } from "@/lib/csv";
import { fromCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";

export type ExportEntity = "contacts" | "companies" | "deals" | "projects" | "opportunities" | "tasks";

/**
 * CSV export. Runs server-side and returns the text, so the browser never needs
 * the whole dataset in memory before the download starts.
 */
export async function exportCsv(entity: ExportEntity, scopeParam?: string | null) {
  return action(async (user) => {
    const { workspaceIds } = await resolveScope(user.id, scopeParam);
    const where = { workspaceId: { in: workspaceIds } };

    switch (entity) {
      case "contacts": {
        const rows = await db.contact.findMany({
          where: { ...where, archivedAt: null },
          include: { company: { select: { name: true } }, owner: { select: { name: true } } },
          orderBy: { fullName: "asc" },
        });
        return {
          filename: "contacts.csv",
          csv: toCsv(
            rows.map((c) => ({
              "First Name": c.firstName,
              "Last Name": c.lastName,
              "Job Title": c.jobTitle,
              Company: c.company?.name,
              Email: c.email,
              Phone: c.phone,
              Website: c.website,
              LinkedIn: c.linkedin,
              Location: c.location,
              "Relationship Type": c.relationshipType,
              "Lead Source": c.leadSource,
              Owner: c.owner?.name,
              "Last Contacted": formatDate(c.lastContactedAt, ""),
              "Next Follow-Up": formatDate(c.nextFollowUpAt, ""),
              Notes: c.description,
              Created: formatDate(c.createdAt),
            })),
          ),
        };
      }
      case "companies": {
        const rows = await db.company.findMany({
          where: { ...where, archivedAt: null },
          include: { primaryContact: { select: { fullName: true } } },
          orderBy: { name: "asc" },
        });
        return {
          filename: "companies.csv",
          csv: toCsv(
            rows.map((c) => ({
              Name: c.name,
              Domain: c.domain,
              Industry: c.industry,
              Website: c.website,
              Size: c.size,
              Location: c.location,
              "Revenue Range": c.revenueRange,
              Type: c.type,
              "Relationship Status": c.relationshipStatus,
              "Lead Source": c.leadSource,
              "Primary Contact": c.primaryContact?.fullName,
              Description: c.description,
              Created: formatDate(c.createdAt),
            })),
          ),
        };
      }
      case "deals": {
        const rows = await db.deal.findMany({
          where: { ...where, archivedAt: null },
          include: {
            company: { select: { name: true } },
            primaryContact: { select: { fullName: true } },
            project: { select: { name: true } },
            stage: { select: { name: true } },
            pipeline: { select: { name: true } },
          },
          orderBy: { valueCents: "desc" },
        });
        return {
          filename: "deals.csv",
          csv: toCsv(
            rows.map((d) => ({
              Name: d.name,
              Company: d.company?.name,
              "Primary Contact": d.primaryContact?.fullName,
              Project: d.project?.name,
              Pipeline: d.pipeline.name,
              Stage: d.stage.name,
              Value: fromCents(d.valueCents),
              "Expected Close": formatDate(d.expectedCloseAt, ""),
              Source: d.source,
              "Next Step": d.nextStep,
              "Closed At": formatDate(d.closedAt, ""),
              Created: formatDate(d.createdAt),
            })),
          ),
        };
      }
      case "projects": {
        const rows = await db.project.findMany({
          where: { ...where, archivedAt: null },
          include: { company: { select: { name: true } }, status: { select: { name: true } } },
          orderBy: { name: "asc" },
        });
        return {
          filename: "projects.csv",
          csv: toCsv(
            rows.map((p) => ({
              Name: p.name,
              Client: p.company?.name,
              Status: p.status?.name,
              Type: p.type,
              Priority: p.priority,
              Health: p.health,
              "Start Date": formatDate(p.startDate, ""),
              "Target Date": formatDate(p.targetDate, ""),
              Budget: p.budgetCents ? fromCents(p.budgetCents) : "",
              Revenue: p.revenueCents ? fromCents(p.revenueCents) : "",
              "Next Action": p.nextAction,
              Description: p.description,
            })),
          ),
        };
      }
      case "opportunities": {
        const rows = await db.opportunity.findMany({
          where: { ...where, archivedAt: null },
          include: { company: { select: { name: true } } },
          orderBy: { deadlineAt: "asc" },
        });
        return {
          filename: "opportunities.csv",
          csv: toCsv(
            rows.map((o) => ({
              Name: o.name,
              Organization: o.company?.name,
              Type: o.type,
              Source: o.source,
              "Solicitation Number": o.solicitationNumber,
              "Posted Date": formatDate(o.postedAt, ""),
              "Questions Deadline": formatDate(o.questionsDeadlineAt, ""),
              "Proposal Deadline": formatDate(o.proposalDeadlineAt, ""),
              "Estimated Value": o.estimatedValueCents ? fromCents(o.estimatedValueCents) : "",
              "Fit Score": o.fitScore,
              "Strategic Value": o.strategicValue,
              Competition: o.competitionLevel,
              "Submission Status": o.submissionStatus,
              Requirements: o.requirements,
            })),
          ),
        };
      }
      case "tasks": {
        const rows = await db.task.findMany({
          where,
          include: {
            project: { select: { name: true } },
            deal: { select: { name: true } },
            contact: { select: { fullName: true } },
            company: { select: { name: true } },
          },
          orderBy: { dueAt: "asc" },
        });
        return {
          filename: "tasks.csv",
          csv: toCsv(
            rows.map((t) => ({
              Task: t.title,
              Description: t.description,
              Status: t.status,
              Priority: t.priority,
              "Due Date": formatDate(t.dueAt, ""),
              Recurring: t.recurrence,
              Project: t.project?.name,
              Deal: t.deal?.name,
              Contact: t.contact?.fullName,
              Company: t.company?.name,
              Completed: formatDate(t.completedAt, ""),
            })),
          ),
        };
      }
    }
  });
}

export type ImportPreview = {
  headers: string[];
  mapped: Record<string, string | null>;
  rows: Record<string, string>[];
  total: number;
};

const CONTACT_COLUMNS: Record<string, string[]> = {
  firstName: ["first name", "firstname", "given name", "first"],
  lastName: ["last name", "lastname", "surname", "family name", "last"],
  email: ["email", "email address", "e-mail", "work email"],
  phone: ["phone", "phone number", "mobile", "work phone"],
  jobTitle: ["job title", "title", "position", "role"],
  company: ["company", "company name", "organization", "account", "employer"],
  location: ["location", "city", "address"],
  website: ["website", "url"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile"],
};

const COMPANY_COLUMNS: Record<string, string[]> = {
  name: ["company name", "name", "organization", "account name"],
  domain: ["domain", "website domain"],
  website: ["website", "url", "web site"],
  industry: ["industry", "sector", "vertical"],
  location: ["location", "city", "address", "headquarters"],
  size: ["size", "employees", "company size", "employee count"],
};

/** Parses and maps a CSV without writing anything, so the user can confirm. */
export async function previewImport(
  entity: "contacts" | "companies",
  csvText: string,
): Promise<{ ok: true; data: ImportPreview } | { ok: false; error: string }> {
  try {
    const rows = parseCsv(csvText);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };

    const headers = Object.keys(rows[0]!);
    const columns = entity === "contacts" ? CONTACT_COLUMNS : COMPANY_COLUMNS;
    const mapped = Object.fromEntries(
      Object.entries(columns).map(([field, candidates]) => [field, matchColumn(headers, candidates)]),
    );

    return {
      ok: true,
      data: { headers, mapped, rows: rows.slice(0, 5), total: rows.length },
    };
  } catch {
    return { ok: false, error: "That file could not be parsed as CSV." };
  }
}

export async function runImport(
  entity: "contacts" | "companies",
  workspaceId: string,
  csvText: string,
) {
  return action(async (user) => {
    await requireWorkspace(user.id, workspaceId);

    const rows = parseCsv(csvText);
    const headers = Object.keys(rows[0] ?? {});
    const columns = entity === "contacts" ? CONTACT_COLUMNS : COMPANY_COLUMNS;
    const map = Object.fromEntries(
      Object.entries(columns).map(([field, candidates]) => [field, matchColumn(headers, candidates)]),
    );
    const get = (row: Record<string, string>, field: string) => {
      const header = map[field];
      return header ? row[header]?.trim() || null : null;
    };

    await assertWithinLimit(user, entity === "contacts" ? "contacts" : "companies", rows.length);

    let created = 0;
    let skipped = 0;

    if (entity === "companies") {
      for (const row of rows) {
        const name = get(row, "name");
        if (!name) {
          skipped++;
          continue;
        }
        // Skip rather than duplicate — imports are usually re-runs.
        const existing = await db.company.findFirst({ where: { workspaceId, name }, select: { id: true } });
        if (existing) {
          skipped++;
          continue;
        }
        await db.company.create({
          data: {
            workspaceId,
            name,
            domain: get(row, "domain"),
            website: get(row, "website"),
            industry: get(row, "industry"),
            location: get(row, "location"),
            size: get(row, "size"),
            ownerId: user.id,
          },
        });
        created++;
      }
    } else {
      for (const row of rows) {
        const firstName = get(row, "firstName");
        const lastName = get(row, "lastName") ?? "";
        const email = get(row, "email");
        if (!firstName && !email) {
          skipped++;
          continue;
        }
        if (email) {
          const existing = await db.contact.findFirst({
            where: { workspaceId, email },
            select: { id: true },
          });
          if (existing) {
            skipped++;
            continue;
          }
        }

        // Attach to a company by name, creating it if the import references one
        // we do not have — otherwise the contact arrives orphaned.
        const companyName = get(row, "company");
        let companyId: string | null = null;
        if (companyName) {
          const company = await db.company.findFirst({
            where: { workspaceId, name: companyName },
            select: { id: true },
          });
          companyId =
            company?.id ??
            (await db.company.create({
              data: { workspaceId, name: companyName, ownerId: user.id },
            })).id;
        }

        const first = firstName ?? email!.split("@")[0]!;
        await db.contact.create({
          data: {
            workspaceId,
            firstName: first,
            lastName,
            fullName: `${first} ${lastName}`.trim(),
            email,
            phone: get(row, "phone"),
            jobTitle: get(row, "jobTitle"),
            location: get(row, "location"),
            website: get(row, "website"),
            linkedin: get(row, "linkedin"),
            companyId,
            ownerId: user.id,
          },
        });
        created++;
      }
    }

    revalidateRecord(["/contacts", "/companies"]);
    return { created, skipped, total: rows.length };
  });
}
