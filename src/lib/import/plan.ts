/**
 * Turning staged rows and an agreed mapping into what will actually happen.
 *
 * This is the step the preview shows and the commit replays. It is pure — no
 * database, no clock beyond what is passed in — so the same function produces
 * the preview and drives the write, and the two cannot drift apart. That
 * drift is the specific defect this importer replaces: the old one previewed
 * from one computation and wrote from another.
 *
 * Duplicate matching needs the database and so is not here; it is applied on
 * top by the action, which fills in `match` on the drafts below.
 */

import { coerceBoolean, coerceDate, coerceInt, coerceMoneyCents, coerceText, isBlank } from "@/lib/import/coerce";
import { REQUIRED_FIELD, TARGETS_BY_KEY, type ImportEntity } from "@/lib/import/targets";
import { coerceEnum } from "@/lib/import/coerce";

/** The agreed mapping: column index → target key, or null for "do not import". */
export type ColumnMapping = { index: number; targetKey: string | null }[];

export type RowIssue = {
  column: string;
  raw: string;
  reason: string;
  /** blocking issues stop the row; noted ones are kept for the record. */
  severity: "blocking" | "noted";
};

export type EntityDraft = {
  entity: ImportEntity;
  /** Field values ready for the writer. */
  values: Record<string, string | number | boolean | Date | null>;
  /** For a reference column: the name to match a parent record by. */
  referenceName?: string;
};

export type RowPlan = {
  rowIndex: number;
  raw: Record<string, string>;
  drafts: EntityDraft[];
  issues: RowIssue[];
  /** create | skip | error — "update" is decided later, by duplicate matching. */
  decision: "create" | "skip" | "error";
  /** Why, when it is not simply "create". */
  note?: string;
};

/**
 * Builds the plan for one row.
 *
 * A refused coercion never becomes a value. It becomes an issue and the field
 * is left unset, so a row with an unreadable deadline still imports — with no
 * deadline and a visible reason — rather than importing a wrong one or being
 * dropped entirely. Only a missing required field stops a record being made,
 * because at that point there is nothing to make.
 */
export function planRow(
  headers: string[],
  cells: string[],
  mapping: ColumnMapping,
  rowIndex: number,
): RowPlan {
  const raw: Record<string, string> = {};
  headers.forEach((header, i) => {
    if (header.trim()) raw[header] = (cells[i] ?? "").trim();
  });

  const issues: RowIssue[] = [];
  const byEntity = new Map<ImportEntity, EntityDraft>();
  const draftFor = (entity: ImportEntity): EntityDraft => {
    const existing = byEntity.get(entity);
    if (existing) return existing;
    const created: EntityDraft = { entity, values: {} };
    byEntity.set(entity, created);
    return created;
  };

  for (const column of mapping) {
    if (!column.targetKey) continue;
    const target = TARGETS_BY_KEY.get(column.targetKey);
    if (!target) continue;

    const header = headers[column.index] ?? `Column ${column.index + 1}`;
    const value = (cells[column.index] ?? "").trim();

    // Recalculated by Tiny. The column is still on the row as provenance, so
    // nothing is lost by not writing it — and writing it would freeze a number
    // that is supposed to move.
    if (target.derived) continue;

    if (isBlank(value)) continue;

    if (target.kind === "reference") {
      const name = value.slice(0, 200);
      // Two things, deliberately. The owning record gets the name to link by,
      // and the referenced record becomes a draft of its own — otherwise the
      // preview cannot say "5 companies will be created", which is precisely
      // the question somebody asks before agreeing to an import.
      draftFor(target.entity).referenceName = name;
      if (target.referenceTo) {
        const parent = draftFor(target.referenceTo);
        const required = REQUIRED_FIELD[target.referenceTo];
        if (parent.values[required] == null) parent.values[required] = name;
      }
      continue;
    }

    const coerced = coerceValue(value, target);
    if (!coerced.ok) {
      issues.push({ column: header, raw: value, reason: coerced.reason, severity: "noted" });
      continue;
    }
    if (coerced.value === null) continue;
    if (coerced.note) {
      issues.push({ column: header, raw: value, reason: coerced.note, severity: "noted" });
    }
    draftFor(target.entity).values[target.field] = coerced.value;
  }

  // A contact given only a full name still needs the two columns the schema
  // stores. Splitting on the last space is imperfect for compound surnames and
  // is the reason the split is recorded rather than assumed silently.
  const contact = byEntity.get("contact");
  if (contact && typeof contact.values.fullName === "string" && !contact.values.firstName) {
    const full = contact.values.fullName.trim();
    const cut = full.lastIndexOf(" ");
    contact.values.firstName = cut === -1 ? full : full.slice(0, cut);
    contact.values.lastName = cut === -1 ? "" : full.slice(cut + 1);
  }

  // Drop drafts that have nothing identifying in them. A "Next Action" column
  // that is blank on this row should not produce an empty task.
  const drafts: EntityDraft[] = [];
  for (const draft of byEntity.values()) {
    const required = REQUIRED_FIELD[draft.entity];
    const hasRequired =
      draft.values[required] != null && String(draft.values[required]).trim() !== "";
    const isReferenceOnly = Object.keys(draft.values).length === 0 && draft.referenceName;
    if (hasRequired || isReferenceOnly) drafts.push(draft);
  }

  if (drafts.length === 0) {
    return {
      rowIndex,
      raw,
      drafts: [],
      issues,
      decision: "skip",
      note: "Nothing on this row maps to a record.",
    };
  }

  return { rowIndex, raw, drafts, issues, decision: "create" };
}

function coerceValue(value: string, target: NonNullable<ReturnType<typeof TARGETS_BY_KEY.get>>) {
  switch (target.kind) {
    case "date": return coerceDate(value);
    case "money": return coerceMoneyCents(value);
    case "int": return coerceInt(value, target.min, target.max);
    case "boolean": return coerceBoolean(value);
    case "enum": return coerceEnum(value, target.options ?? [], target.optionAliases ?? {});
    case "longtext": return coerceText(value, target.max ?? 10_000);
    default: return coerceText(value, target.max ?? 200);
  }
}

/** Plans every row. */
export function planRows(
  headers: string[],
  rows: string[][],
  mapping: ColumnMapping,
): RowPlan[] {
  return rows.map((cells, i) => planRow(headers, cells, mapping, i));
}

export type PlanSummary = {
  rows: number;
  byEntity: Record<string, number>;
  skipped: number;
  withIssues: number;
  /** Columns carrying data that will not be written anywhere. */
  unmappedColumns: string[];
  /** Columns recognised but recalculated by Tiny rather than imported. */
  derivedColumns: string[];
};

/**
 * What the person is agreeing to.
 *
 * `unmappedColumns` only lists columns that actually contain data. A blank
 * column nobody filled in is not information being lost, and listing it would
 * bury the ones that are.
 */
export function summarise(
  headers: string[],
  rows: string[][],
  mapping: ColumnMapping,
  plans: RowPlan[],
): PlanSummary {
  const byEntity: Record<string, number> = {};
  let withIssues = 0;
  for (const plan of plans) {
    if (plan.issues.length > 0) withIssues++;
    for (const draft of plan.drafts) {
      byEntity[draft.entity] = (byEntity[draft.entity] ?? 0) + 1;
    }
  }

  const mapped = new Map(mapping.map((m) => [m.index, m.targetKey]));
  const unmappedColumns: string[] = [];
  const derivedColumns: string[] = [];
  headers.forEach((header, index) => {
    if (!header.trim()) return;
    const key = mapped.get(index) ?? null;
    const hasData = rows.some((r) => !isBlank(r[index] ?? ""));
    if (!hasData) return;
    if (!key) {
      unmappedColumns.push(header);
      return;
    }
    if (TARGETS_BY_KEY.get(key)?.derived) derivedColumns.push(header);
  });

  return {
    rows: rows.length,
    byEntity,
    skipped: plans.filter((p) => p.decision === "skip").length,
    withIssues,
    unmappedColumns,
    derivedColumns,
  };
}
