"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { ActionResult, audit, guard, transaction, workspaceAction } from "@/lib/actions/base";
import { assertWithinLimit } from "@/lib/entitlements";
import { AppError } from "@/lib/errors";
import { parseCsvGrid } from "@/lib/csv";
import { detectTable, type RawSheet } from "@/lib/import/detect";
import { proposeMapping, type ColumnProposal } from "@/lib/import/mapping";
import { planRows, summarise, type ColumnMapping, type PlanSummary, type RowPlan } from "@/lib/import/plan";
import { REQUIRED_FIELD, type ImportEntity } from "@/lib/import/targets";
import { parseJson } from "@/lib/json";
import { LIMITS } from "@/lib/validation/limits";
import { zId } from "@/lib/validation/common";

/**
 * The import, from a file to records that can be undone.
 *
 * Four things hold this together, and each replaces a specific failure of the
 * importer it succeeds:
 *
 *  1. **The mapping is stored server-side.** The old flow re-sent the raw file
 *     on confirm and rebuilt the mapping from scratch, so the preview and the
 *     write were two computations that merely tended to agree.
 *  2. **The commit is one transaction.** The old one wrote records in a loop,
 *     so a failure at row 3,000 left 2,999 behind with no way to find them.
 *  3. **Plan limits are checked against the whole batch before anything is
 *     written.** Importing until the cap is hit and then stopping is the worst
 *     of both outcomes: a partial pipeline nobody asked for.
 *  4. **Every record carries the batch that made it**, so rollback is a
 *     delete by id rather than a guess.
 */

const MAX_SHEETS = 20;

export type SheetSummary = {
  name: string;
  shape: "records" | "summary" | "empty";
  reason: string;
  rowCount: number;
  headers: string[];
};

export type ImportPreview = {
  batchId: string;
  sheets: SheetSummary[];
  sheetName: string;
  proposals: ColumnProposal[];
  summary: PlanSummary;
  /** The first rows, as they will be written. */
  sample: {
    rowIndex: number;
    decision: RowPlan["decision"];
    note?: string;
    entities: { entity: ImportEntity; label: string; match: "new" | "existing" }[];
    issues: RowPlan["issues"];
  }[];
  /** Existing records these rows will attach to rather than duplicate. */
  duplicates: { entity: ImportEntity; name: string; count: number }[];
  /** Set when committing would cross a plan limit. */
  planProblem?: { limitKey: string; limit: number; needed: number; have: number };
  preamble: string[][];
  trailing: string[][];
};

const analyzeSchema = z.object({
  workspaceId: zId,
  fileName: z.string().min(1).max(300),
  /** The file's text. Only CSV for now; a workbook reader lands separately. */
  content: z.string().max(LIMITS.maxImportBytes),
  sheetName: z.string().max(200).optional(),
});

/**
 * Reads the file, stages it, and says what would happen.
 *
 * The file crosses the wire once. Everything after this works from the stored
 * rows, which is what makes the preview binding rather than advisory.
 */
export async function analyzeSpreadsheet(
  input: z.input<typeof analyzeSchema>,
): Promise<ActionResult<ImportPreview>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspace(input), permission: "import:run", rateLimit: "import" },
      async (actor) => {
        const data = analyzeSchema.parse(input);
        const workspaceId = actor.workspaceId;

        const sheets = readSheets(data.content);
        if (sheets.length === 0) {
          throw new AppError("validation", "That file has no readable rows.");
        }

        const detected = sheets.slice(0, MAX_SHEETS).map(detectTable);
        const chosen =
          detected.find((d) => d.name === data.sheetName) ??
          detected.filter((d) => d.shape === "records").sort((a, b) => b.rows.length - a.rows.length)[0] ??
          detected[0]!;

        if (chosen.rows.length > LIMITS.maxImportRows) {
          throw new AppError(
            "validation",
            `That sheet has ${chosen.rows.length.toLocaleString()} rows; the limit is ` +
              `${LIMITS.maxImportRows.toLocaleString()}.`,
          );
        }

        const proposals = proposeMapping(chosen.headers, chosen.rows);
        const mapping: ColumnMapping = proposals.map((p) => ({ index: p.index, targetKey: p.targetKey }));

        const batch = await transaction(async (tx) => {
          const created = await tx.importBatch.create({
            data: {
              workspaceId,
              actorId: actor.identity.id,
              sourceName: data.fileName.slice(0, 300),
              sourceKind: "csv",
              sheetName: chosen.name.slice(0, 200),
              status: "draft",
              mapping: JSON.stringify(mapping),
              rowCount: chosen.rows.length,
            },
            select: { id: true },
          });

          // The whole original row, verbatim. This is the provenance: a column
          // Tiny recalculates or has no field for is still here afterwards.
          for (let i = 0; i < chosen.rows.length; i++) {
            const raw: Record<string, string> = {};
            chosen.headers.forEach((header, index) => {
              if (header.trim()) raw[header] = (chosen.rows[i]![index] ?? "").slice(0, 5000);
            });
            await tx.importRow.create({
              data: { batchId: created.id, rowIndex: i, raw: JSON.stringify(raw) },
            });
          }
          return created;
        });

        return buildPreview(actor, batch.id, detected, chosen.name, mapping);
      },
    ),
  );
}

const mappingSchema = z.object({
  batchId: zId,
  workspaceId: zId,
  mapping: z
    .array(z.object({ index: z.number().int().min(0).max(500), targetKey: z.string().max(120).nullable() }))
    .max(500),
});

/** Replaces the agreed mapping and re-previews from the stored rows. */
export async function updateImportMapping(
  input: z.input<typeof mappingSchema>,
): Promise<ActionResult<ImportPreview>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspace(input), permission: "import:run", rateLimit: "mutation" },
      async (actor) => {
        const data = mappingSchema.parse(input);
        const batch = await requireBatch(actor.workspaceId, data.batchId);
        if (batch.status !== "draft" && batch.status !== "previewed") {
          throw new AppError("conflict", "That import has already been committed.");
        }

        await db.importBatch.updateMany({
          where: { id: batch.id, workspaceId: actor.workspaceId },
          data: { mapping: JSON.stringify(data.mapping), status: "previewed" },
        });

        const { headers } = await loadRows(batch.id);
        return buildPreview(
          actor,
          batch.id,
          [{ name: batch.sheetName ?? "Sheet", shape: "records", reason: "", headers }],
          batch.sheetName ?? "Sheet",
          data.mapping,
        );
      },
    ),
  );
}

const commitSchema = z.object({ batchId: zId, workspaceId: zId });

/**
 * Writes the batch, or writes nothing.
 *
 * Plan limits are checked against the whole batch first. Partially importing
 * until a cap is hit produces a pipeline that is neither the spreadsheet's nor
 * Tiny's, and the person has no way to tell which rows made it.
 */
export async function commitImport(
  input: z.input<typeof commitSchema>,
): Promise<ActionResult<{ created: Record<string, number>; matched: number }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspace(input), permission: "import:run", rateLimit: "import" },
      async (actor) => {
        const data = commitSchema.parse(input);
        const workspaceId = actor.workspaceId;
        const batch = await requireBatch(workspaceId, data.batchId);

        if (batch.status === "committed") {
          throw new AppError("conflict", "That import has already been committed.");
        }
        if (batch.status === "rolled_back") {
          throw new AppError("conflict", "That import was rolled back and cannot be replayed.");
        }

        const mapping = parseJson<ColumnMapping>(batch.mapping, []);
        const { headers, rows } = await loadRows(batch.id);
        const plans = planRows(headers, rows, mapping);

        const existing = await findExisting(workspaceId, plans);
        const counts = countNew(plans, existing);

        // Before anything is written.
        for (const [entity, needed] of Object.entries(counts)) {
          if (needed === 0) continue;
          await assertWithinLimit(actor, PLAN_KEY[entity as ImportEntity], needed);
        }

        let matched = 0;
        const created: Record<string, number> = {};

        await transaction(async (tx) => {
          // Company first: opportunities and contacts link to it by name.
          const companyIds = new Map<string, string>(existing.company);

          for (const plan of plans) {
            if (plan.decision !== "create") continue;

            for (const draft of plan.drafts) {
              if (draft.entity !== "company") continue;
              const name = String(draft.values.name ?? "").trim();
              if (!name) continue;
              const key = name.toLowerCase();
              if (companyIds.has(key)) { matched++; continue; }
              const row = await tx.company.create({
                data: {
                  workspaceId,
                  name,
                  location: asText(draft.values.location),
                  website: asText(draft.values.website),
                  domain: asText(draft.values.domain),
                  industry: asText(draft.values.industry),
                  size: asText(draft.values.size),
                  type: asText(draft.values.type),
                  leadSource: asText(draft.values.leadSource),
                  description: asText(draft.values.description),
                  relationshipStatus: asText(draft.values.relationshipStatus) ?? "prospect",
                  ownerId: actor.identity.id,
                  sourceBatchId: batch.id,
                },
                select: { id: true },
              });
              companyIds.set(key, row.id);
              created.company = (created.company ?? 0) + 1;
            }
          }

          for (const plan of plans) {
            if (plan.decision !== "create") continue;
            const outcome: Record<string, string> = {};

            const opportunity = plan.drafts.find((d) => d.entity === "opportunity");
            let opportunityId: string | null = null;
            if (opportunity) {
              const companyKey = opportunity.referenceName?.trim().toLowerCase();
              const row = await tx.opportunity.create({
                data: {
                  workspaceId,
                  name: String(opportunity.values.name),
                  companyId: companyKey ? (companyIds.get(companyKey) ?? null) : null,
                  solicitationNumber: asText(opportunity.values.solicitationNumber),
                  source: asText(opportunity.values.source),
                  type: asText(opportunity.values.type) ?? "rfp",
                  submissionStatus: asText(opportunity.values.submissionStatus) ?? "not_started",
                  requirements: asText(opportunity.values.requirements),
                  proposalUrl: asText(opportunity.values.proposalUrl),
                  estimatedValueCents: asInt(opportunity.values.estimatedValueCents),
                  postedAt: asDate(opportunity.values.postedAt),
                  questionsDeadlineAt: asDate(opportunity.values.questionsDeadlineAt),
                  proposalDeadlineAt: asDate(opportunity.values.proposalDeadlineAt),
                  deadlineAt:
                    asDate(opportunity.values.proposalDeadlineAt) ??
                    asDate(opportunity.values.questionsDeadlineAt),
                  ownerId: actor.identity.id,
                  sourceBatchId: batch.id,
                },
                select: { id: true },
              });
              opportunityId = row.id;
              outcome.opportunity = row.id;
              created.opportunity = (created.opportunity ?? 0) + 1;
            }

            const contact = plan.drafts.find((d) => d.entity === "contact");
            if (contact) {
              const first = String(contact.values.firstName ?? "").trim();
              const last = String(contact.values.lastName ?? "").trim();
              const companyKey = contact.referenceName?.trim().toLowerCase();
              const row = await tx.contact.create({
                data: {
                  workspaceId,
                  firstName: first,
                  lastName: last,
                  fullName: `${first} ${last}`.trim(),
                  email: asText(contact.values.email),
                  phone: asText(contact.values.phone),
                  jobTitle: asText(contact.values.jobTitle),
                  relationshipType: asText(contact.values.relationshipType) ?? "prospect",
                  companyId: companyKey ? (companyIds.get(companyKey) ?? null) : null,
                  ownerId: actor.identity.id,
                  sourceBatchId: batch.id,
                },
                select: { id: true },
              });
              outcome.contact = row.id;
              created.contact = (created.contact ?? 0) + 1;
            }

            const task = plan.drafts.find((d) => d.entity === "task");
            if (task) {
              const row = await tx.task.create({
                data: {
                  workspaceId,
                  title: String(task.values.title),
                  dueAt: asDate(task.values.dueAt),
                  priority: asText(task.values.priority) ?? "medium",
                  opportunityId,
                  ownerId: actor.identity.id,
                  sourceBatchId: batch.id,
                },
                select: { id: true },
              });
              outcome.task = row.id;
              created.task = (created.task ?? 0) + 1;
            }

            await tx.importRow.updateMany({
              where: { batchId: batch.id, rowIndex: plan.rowIndex },
              data: {
                outcome: JSON.stringify(outcome),
                decision: plan.decision,
                issues: JSON.stringify(plan.issues),
              },
            });
          }

          await tx.importBatch.updateMany({
            where: { id: batch.id, workspaceId },
            data: {
              status: "committed",
              committedAt: new Date(),
              createdCount: Object.values(created).reduce((a, b) => a + b, 0),
              matchedCount: matched,
              skippedCount: plans.filter((p) => p.decision === "skip").length,
              errorCount: plans.filter((p) => p.decision === "error").length,
              stats: JSON.stringify({ created, matched }),
            },
          });
        });

        await audit(actor, {
          workspaceId,
          action: "data.imported",
          entityType: "importBatch",
          entityId: batch.id,
          summary: `Imported ${batch.sourceName}`,
          metadata: { created, matched, rows: plans.length },
        });

        return { created, matched };
      },
    ),
  );
}

const rollbackSchema = z.object({ batchId: zId, workspaceId: zId });

/**
 * Undoes a committed import, exactly.
 *
 * Every record written by the batch carries its id, so this deletes what the
 * import made and nothing else. Records created afterwards, and records the
 * import merely *linked to* rather than created, are untouched — matching an
 * existing company does not put a batch id on it, which is what keeps a
 * rollback from taking a company that was already there.
 */
export async function rollbackImport(
  input: z.input<typeof rollbackSchema>,
): Promise<ActionResult<{ removed: Record<string, number> }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspace(input), permission: "import:run", rateLimit: "import" },
      async (actor) => {
        const data = rollbackSchema.parse(input);
        const workspaceId = actor.workspaceId;
        const batch = await requireBatch(workspaceId, data.batchId);

        if (batch.status !== "committed") {
          throw new AppError("conflict", "That import has not been committed.");
        }

        const removed: Record<string, number> = {};
        await transaction(async (tx) => {
          // Children before parents: a task points at an opportunity, and an
          // opportunity at a company.
          const where = { workspaceId, sourceBatchId: batch.id };
          removed.task = (await tx.task.deleteMany({ where })).count;
          removed.opportunity = (await tx.opportunity.deleteMany({ where })).count;
          removed.contact = (await tx.contact.deleteMany({ where })).count;
          removed.company = (await tx.company.deleteMany({ where })).count;

          await tx.importBatch.updateMany({
            where: { id: batch.id, workspaceId },
            data: { status: "rolled_back", rolledBackAt: new Date() },
          });
        });

        await audit(actor, {
          workspaceId,
          action: "data.imported",
          entityType: "importBatch",
          entityId: batch.id,
          summary: `Rolled back import ${batch.sourceName}`,
          metadata: { removed },
        });

        return { removed };
      },
    ),
  );
}

// ---------------------------------------------------------------------------

const PLAN_KEY: Record<ImportEntity, "companies" | "contacts" | "opportunities" | "tasks"> = {
  company: "companies",
  contact: "contacts",
  opportunity: "opportunities",
  task: "tasks",
};

function readWorkspace(input: unknown): string {
  const value = (input as { workspaceId?: unknown })?.workspaceId;
  return typeof value === "string" ? value : "";
}

async function requireBatch(workspaceId: string, batchId: string) {
  const batch = await db.importBatch.findFirst({
    where: { id: batchId, workspaceId },
    select: {
      id: true, status: true, mapping: true, sheetName: true, rowCount: true, sourceName: true,
    },
  });
  if (!batch) throw new AppError("not_found", "That import could not be found.");
  return batch;
}

async function loadRows(batchId: string): Promise<{ headers: string[]; rows: string[][] }> {
  const stored = await db.importRow.findMany({
    where: { batchId },
    orderBy: { rowIndex: "asc" },
    select: { raw: true },
  });
  const parsed = stored.map((r) => parseJson<Record<string, string>>(r.raw, {}));
  const headers = parsed.length ? Object.keys(parsed[0]!) : [];
  return { headers, rows: parsed.map((row) => headers.map((h) => row[h] ?? "")) };
}

/** Existing records these rows would otherwise duplicate, by lowercased name. */
async function findExisting(workspaceId: string, plans: RowPlan[]) {
  const names = new Set<string>();
  for (const plan of plans) {
    for (const draft of plan.drafts) {
      if (draft.entity !== "company") continue;
      const name = String(draft.values.name ?? "").trim();
      if (name) names.add(name);
    }
  }
  const rows = names.size
    ? await db.company.findMany({
        where: { workspaceId, name: { in: [...names] } },
        select: { id: true, name: true },
      })
    : [];
  return { company: new Map(rows.map((r) => [r.name.toLowerCase(), r.id])) };
}

function countNew(plans: RowPlan[], existing: { company: Map<string, string> }) {
  const counts: Record<string, number> = { company: 0, contact: 0, opportunity: 0, task: 0 };
  const seenCompany = new Set(existing.company.keys());
  for (const plan of plans) {
    if (plan.decision !== "create") continue;
    for (const draft of plan.drafts) {
      if (draft.entity === "company") {
        const key = String(draft.values.name ?? "").trim().toLowerCase();
        if (!key || seenCompany.has(key)) continue;
        seenCompany.add(key);
      }
      counts[draft.entity] = (counts[draft.entity] ?? 0) + 1;
    }
  }
  return counts;
}

async function buildPreview(
  actor: { workspaceId: string; identity: { plan: string } },
  batchId: string,
  detected: { name: string; shape: string; reason: string; rows?: string[][]; headers: string[]; preamble?: string[][]; trailing?: string[][] }[],
  sheetName: string,
  mapping: ColumnMapping,
): Promise<ImportPreview> {
  const { headers, rows } = await loadRows(batchId);
  const plans = planRows(headers, rows, mapping);
  const proposals = proposeMapping(headers, rows).map((p) => ({
    ...p,
    targetKey: mapping.find((m) => m.index === p.index)?.targetKey ?? null,
  }));
  const summary = summarise(headers, rows, mapping, plans);
  const existing = await findExisting(actor.workspaceId, plans);
  const counts = countNew(plans, existing);

  let planProblem: ImportPreview["planProblem"];
  for (const [entity, needed] of Object.entries(counts)) {
    if (needed === 0 || planProblem) continue;
    try {
      await assertWithinLimit(actor as never, PLAN_KEY[entity as ImportEntity], needed);
    } catch (error) {
      const meta = error as { limitKey?: string; limit?: number };
      planProblem = {
        limitKey: meta.limitKey ?? entity,
        limit: meta.limit ?? 0,
        needed,
        have: Math.max(0, (meta.limit ?? 0) - needed),
      };
    }
  }

  const duplicates = [...existing.company.keys()].length
    ? [{ entity: "company" as const, name: "matched by name", count: existing.company.size }]
    : [];

  const chosen = detected.find((d) => d.name === sheetName);
  return {
    batchId,
    sheets: detected.map((d) => ({
      name: d.name,
      shape: d.shape as SheetSummary["shape"],
      reason: d.reason,
      rowCount: d.rows?.length ?? 0,
      headers: d.headers,
    })),
    sheetName,
    proposals,
    summary,
    sample: plans.slice(0, 25).map((plan) => ({
      rowIndex: plan.rowIndex,
      decision: plan.decision,
      note: plan.note,
      entities: plan.drafts.map((d) => ({
        entity: d.entity,
        label: String(d.values[REQUIRED_FIELD[d.entity]] ?? d.referenceName ?? ""),
        match:
          d.entity === "company" &&
          existing.company.has(String(d.values.name ?? "").trim().toLowerCase())
            ? ("existing" as const)
            : ("new" as const),
      })),
      issues: plan.issues,
    })),
    duplicates,
    planProblem,
    preamble: chosen?.preamble ?? [],
    trailing: chosen?.trailing ?? [],
  };
}

function readSheets(content: string): RawSheet[] {
  const grid = parseCsvGrid(content, {
    maxRows: LIMITS.maxImportRows,
    maxBytes: LIMITS.maxImportBytes,
  });
  return grid.length ? [{ name: "Sheet 1", rows: grid }] : [];
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asDate(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}
