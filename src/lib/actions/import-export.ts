"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit, guard, revalidateRecord, workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertWithinLimit } from "@/lib/entitlements";
import { CsvError, matchColumn, parseCsv, toCsv } from "@/lib/csv";
import { fromCents } from "@/lib/money";
import { formatDate, formatDateOnly } from "@/lib/dates";
import { LIMITS } from "@/lib/validation/limits";
import { zId } from "@/lib/validation/common";

/**
 * Bulk data movement.
 *
 * Export and import are treated as their own risk class, separate from reading
 * or writing one record:
 *
 *  - Both require an explicit permission (`record:export` / `import:run`) that
 *    members do not hold. Being able to see a contact is not the same as being
 *    able to walk out with every contact.
 *  - Both are bound to exactly one workspace. An export never spans the
 *    caller's whole scope, so one file can never mix two clients' data.
 *  - Every exported cell passes through `neutralizeCsvCell`, so a stored value
 *    beginning `=`, `+`, `-` or `@` cannot execute when the file is opened in
 *    Excel or Sheets.
 *  - Both are audited, with row counts. A bulk extraction is the event a
 *    breach investigation looks for first.
 */

export type ExportEntity =
  | "contacts" | "companies" | "deals" | "projects" | "opportunities" | "tasks";

const EXPORT_ENTITIES = [
  "contacts", "companies", "deals", "projects", "opportunities", "tasks",
] as const;

const TAKE = LIMITS.maxExportRows;

export async function exportCsv(
  entity: ExportEntity,
  workspaceId: string,
): Promise<ActionResult<{ filename: string; csv: string; rows: number }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "record:export", rateLimit: "export" },
      async (actor) => {
        const kind = z.enum(EXPORT_ENTITIES).parse(entity);
        const where = { workspaceId: actor.workspaceId };

        const { filename, csv, rows } = await build(kind, where);

        await audit(actor, {
          workspaceId: actor.workspaceId,
          action: "data.exported",
          entityType: kind,
          summary: `Exported ${rows} ${kind} as CSV`,
          metadata: { entity: kind, rows },
        });

        return { filename, csv, rows };
      },
    ),
  );
}

async function build(entity: (typeof EXPORT_ENTITIES)[number], where: { workspaceId: string }) {
  switch (entity) {
    case "contacts": {
      const rows = await db.contact.findMany({
        where: { ...where, archivedAt: null },
        include: { company: { select: { name: true } }, owner: { select: { name: true } } },
        orderBy: { fullName: "asc" },
        take: TAKE,
      });
      return {
        filename: "contacts.csv",
        rows: rows.length,
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
            "Next Follow-Up": formatDateOnly(c.nextFollowUpAt, ""),
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
        take: TAKE,
      });
      return {
        filename: "companies.csv",
        rows: rows.length,
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
        take: TAKE,
      });
      return {
        filename: "deals.csv",
        rows: rows.length,
        csv: toCsv(
          rows.map((d) => ({
            Name: d.name,
            Company: d.company?.name,
            "Primary Contact": d.primaryContact?.fullName,
            Project: d.project?.name,
            Pipeline: d.pipeline.name,
            Stage: d.stage.name,
            Value: fromCents(d.valueCents),
            "Expected Close": formatDateOnly(d.expectedCloseAt, ""),
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
        take: TAKE,
      });
      return {
        filename: "projects.csv",
        rows: rows.length,
        csv: toCsv(
          rows.map((p) => ({
            Name: p.name,
            Client: p.company?.name,
            Status: p.status?.name,
            Type: p.type,
            Priority: p.priority,
            Health: p.health,
            "Start Date": formatDateOnly(p.startDate, ""),
            "Target Date": formatDateOnly(p.targetDate, ""),
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
        take: TAKE,
      });
      return {
        filename: "opportunities.csv",
        rows: rows.length,
        csv: toCsv(
          rows.map((o) => ({
            Name: o.name,
            Organization: o.company?.name,
            Type: o.type,
            Source: o.source,
            "Solicitation Number": o.solicitationNumber,
            "Posted Date": formatDateOnly(o.postedAt, ""),
            "Questions Deadline": formatDateOnly(o.questionsDeadlineAt, ""),
            "Proposal Deadline": formatDateOnly(o.proposalDeadlineAt, ""),
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
        where: { ...where, archivedAt: null },
        include: {
          project: { select: { name: true } },
          deal: { select: { name: true } },
          contact: { select: { fullName: true } },
          company: { select: { name: true } },
        },
        orderBy: { dueAt: "asc" },
        take: TAKE,
      });
      return {
        filename: "tasks.csv",
        rows: rows.length,
        csv: toCsv(
          rows.map((t) => ({
            Task: t.title,
            Description: t.description,
            Status: t.status,
            Priority: t.priority,
            "Due Date": formatDateOnly(t.dueAt, ""),
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
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

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

const csvSchema = z.string().max(LIMITS.maxImportBytes, "That file is too large to import.");

/**
 * Parses and maps a CSV without writing anything, so the user can confirm.
 *
 * Preview still requires an authenticated caller with import rights: the parser
 * is the same code the import runs, and handing an anonymous caller a parser is
 * handing them a CPU.
 */
export async function previewImport(
  entity: "contacts" | "companies",
  csvText: string,
  workspaceId: string,
): Promise<ActionResult<ImportPreview>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "import:run", rateLimit: "import" },
      async () => {
        const kind = z.enum(["contacts", "companies"]).parse(entity);
        const text = csvSchema.parse(csvText);

        const rows = parseCsv(text, {
          maxRows: LIMITS.maxImportRows,
          maxBytes: LIMITS.maxImportBytes,
        });
        if (rows.length === 0) {
          throw new CsvError("That file has no rows.");
        }

        const headers = Object.keys(rows[0]!);
        const columns = kind === "contacts" ? CONTACT_COLUMNS : COMPANY_COLUMNS;
        const mapped = Object.fromEntries(
          Object.entries(columns).map(([field, candidates]) => [
            field,
            matchColumn(headers, candidates),
          ]),
        );

        return { headers, mapped, rows: rows.slice(0, 5), total: rows.length };
      },
    ),
  );
}

export async function runImport(
  entity: "contacts" | "companies",
  workspaceId: string,
  csvText: string,
): Promise<ActionResult<{ created: number; skipped: number; total: number }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "import:run", rateLimit: "import" },
      async (actor) => {
        const kind = z.enum(["contacts", "companies"]).parse(entity);
        const text = csvSchema.parse(csvText);
        const scoped = zId.parse(actor.workspaceId);

        const rows = parseCsv(text, {
          maxRows: LIMITS.maxImportRows,
          maxBytes: LIMITS.maxImportBytes,
        });

        const headers = Object.keys(rows[0] ?? {});
        const columns = kind === "contacts" ? CONTACT_COLUMNS : COMPANY_COLUMNS;
        const map = Object.fromEntries(
          Object.entries(columns).map(([field, candidates]) => [
            field,
            matchColumn(headers, candidates),
          ]),
        );
        const get = (row: Record<string, string>, field: string) => {
          const header = map[field];
          const value = header ? row[header]?.trim() : null;
          // Imported cells are bounded here, not trusted to be sane: a CSV is
          // the easiest place to smuggle a megabyte into a column.
          return value ? value.slice(0, LIMITS.shortText) : null;
        };

        // The plan limit is checked against the whole batch before anything is
        // written, so an import cannot walk past a limit one row at a time.
        await assertWithinLimit(actor, kind === "contacts" ? "contacts" : "companies", rows.length);

        let created = 0;
        let skipped = 0;

        if (kind === "companies") {
          for (const row of rows) {
            const name = get(row, "name");
            if (!name) {
              skipped++;
              continue;
            }
            // Skip rather than duplicate — imports are usually re-runs.
            const existing = await db.company.findFirst({
              where: { workspaceId: scoped, name },
              select: { id: true },
            });
            if (existing) {
              skipped++;
              continue;
            }
            await db.company.create({
              data: {
                workspaceId: scoped,
                name,
                domain: get(row, "domain"),
                website: get(row, "website"),
                industry: get(row, "industry"),
                location: get(row, "location"),
                size: get(row, "size"),
                ownerId: actor.identity.id,
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
                where: { workspaceId: scoped, email },
                select: { id: true },
              });
              if (existing) {
                skipped++;
                continue;
              }
            }

            // Attach to a company by name, creating it if the import references
            // one we do not have — otherwise the contact arrives orphaned. The
            // lookup and the create are both workspace-scoped, so an import can
            // never attach a contact to another tenant's account.
            const companyName = get(row, "company");
            let companyId: string | null = null;
            if (companyName) {
              const company = await db.company.findFirst({
                where: { workspaceId: scoped, name: companyName },
                select: { id: true },
              });
              companyId =
                company?.id ??
                (
                  await db.company.create({
                    data: { workspaceId: scoped, name: companyName, ownerId: actor.identity.id },
                  })
                ).id;
            }

            const first = firstName ?? email!.split("@")[0]!;
            await db.contact.create({
              data: {
                workspaceId: scoped,
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
                ownerId: actor.identity.id,
              },
            });
            created++;
          }
        }

        await audit(actor, {
          workspaceId: scoped,
          action: "data.imported",
          entityType: kind,
          summary: `Imported ${created} ${kind} from CSV`,
          metadata: { entity: kind, created, skipped, total: rows.length },
        });

        revalidateRecord(["/contacts", "/companies"]);
        return { created, skipped, total: rows.length };
      },
    ),
  );
}
