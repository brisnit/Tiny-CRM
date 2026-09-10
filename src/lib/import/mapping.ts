/**
 * Proposing what each column is, and saying why.
 *
 * Two signals, deliberately in this order:
 *
 *  1. The header. "Deadline" is a deadline. This is where nearly all of the
 *     confidence comes from, because a header is a person telling you the
 *     answer in their own words.
 *  2. The values underneath it. A column of ISO dates is a date column even if
 *     its header is blank, and — more usefully — a column whose header matched
 *     a date field but whose values are all prose is a header that lied.
 *
 * Every proposal carries a confidence and a reason in words. The reason is not
 * decoration: the person reviewing the mapping cannot check a number, but they
 * can check "matched the header 'Est. Value'; 3 of 24 values are amounts".
 *
 * No model is involved. Deterministic matching handles the ordinary case, and
 * the cases it cannot settle are surfaced as unmapped rather than guessed —
 * which is the whole contract.
 */

import { coerceBoolean, coerceDate, coerceInt, coerceMoneyCents, isBlank } from "@/lib/import/coerce";
import { FIELD_TARGETS, TARGETS_BY_KEY, type FieldTarget, type ImportEntity } from "@/lib/import/targets";

export type ColumnProposal = {
  /** Position in the header row. Mapping is stored by index, not by name, so
   *  two columns with the same header stay distinguishable. */
  index: number;
  header: string;
  /** Key into FIELD_TARGETS, or null for "do not import". */
  targetKey: string | null;
  confidence: number;
  reason: string;
  /** A few real values, for the person reviewing. */
  samples: string[];
  /** True when the column matched a field Tiny recalculates. */
  derived: boolean;
};

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How well a header matches one target's aliases. 0 when it does not. */
function headerAffinity(header: string, target: FieldTarget): number {
  const key = normalise(header);
  if (!key) return 0;

  for (const alias of target.aliases) {
    const a = normalise(alias);
    if (!a) continue;
    if (key === a) return 1;
  }
  for (const alias of target.aliases) {
    const a = normalise(alias);
    if (a.length < 4) continue;
    // "estvalue" contains "value"; "proposaldeadline" contains "deadline".
    if (key.includes(a) || a.includes(key)) {
      const ratio = Math.min(key.length, a.length) / Math.max(key.length, a.length);
      return 0.55 + 0.3 * ratio;
    }
  }
  return 0;
}

/** What fraction of the non-blank values parse as this kind. */
function valueAffinity(values: string[], target: FieldTarget): { ratio: number; parsed: number; total: number } {
  const present = values.filter((v) => !isBlank(v));
  if (present.length === 0) return { ratio: 0, parsed: 0, total: 0 };

  let parsed = 0;
  for (const value of present) {
    switch (target.kind) {
      case "date": if (coerceDate(value).ok) parsed++; break;
      case "money": if (coerceMoneyCents(value).ok) parsed++; break;
      case "int": if (coerceInt(value, target.min, target.max).ok) parsed++; break;
      case "boolean": if (coerceBoolean(value).ok) parsed++; break;
      case "enum": {
        const key = normalise(value);
        const hit =
          (target.options ?? []).some((o) => normalise(o) === key) ||
          Object.keys(target.optionAliases ?? {}).some((a) => normalise(a) === key);
        if (hit) parsed++;
        break;
      }
      default:
        // Text accepts anything, so it carries no evidence either way.
        parsed++;
    }
  }
  return { ratio: parsed / present.length, parsed, total: present.length };
}

function describe(header: string, target: FieldTarget, header0: number, values: ReturnType<typeof valueAffinity>): string {
  const byHeader =
    header0 === 1
      ? `The header "${header}" is exactly this field.`
      : `The header "${header}" looks like this field.`;

  if (target.kind === "text" || target.kind === "longtext" || target.kind === "reference") {
    return byHeader;
  }
  if (values.total === 0) return `${byHeader} Every value is blank, so there is nothing to check it against.`;
  if (values.ratio === 1) return `${byHeader} All ${values.total} values read as ${target.kind === "money" ? "amounts" : target.kind + "s"}.`;
  return `${byHeader} ${values.parsed} of ${values.total} values read as ${target.kind === "money" ? "amounts" : target.kind + "s"}.`;
}

/**
 * Proposes a target for every column.
 *
 * A target is only taken once. Real trackers repeat a word across several
 * headers — "Deadline" and "Days Left", "Score" and "Adjusted Score" — and
 * without this the same field is proposed twice and one write silently wins.
 * The stronger match keeps the field; the weaker one becomes unmapped and the
 * person decides, which is the right outcome because only they know which of
 * the two columns is the real one.
 */
export function proposeMapping(
  headers: string[],
  rows: string[][],
  options: { entities?: readonly ImportEntity[] } = {},
): ColumnProposal[] {
  const allowed = options.entities;
  const targets = allowed
    ? FIELD_TARGETS.filter((t) => allowed.includes(t.entity))
    : FIELD_TARGETS;

  const sampleOf = (index: number) =>
    rows.slice(0, 200).map((r) => (r[index] ?? "").trim());

  type Scored = { index: number; target: FieldTarget; score: number; reason: string };
  const scored: Scored[] = [];

  headers.forEach((header, index) => {
    if (!header.trim()) return;
    const values = sampleOf(index);

    for (const target of targets) {
      const h = headerAffinity(header, target);
      if (h === 0) continue;

      const v = valueAffinity(values, target);
      // The header proposes and the values corroborate. A header match with
      // values that contradict it is worth less than one with values that
      // agree, but is still worth surfacing — the person can confirm.
      const evidence = v.total === 0 ? 0.6 : v.ratio;
      const score = h * 0.7 + evidence * 0.3;
      scored.push({ index, target, score, reason: describe(header, target, h, v) });
    }
  });

  // What is this sheet about?
  //
  // "Title" is a job title in a contact list and the opportunity name in an RFP
  // tracker, and the header alone cannot separate them — both are exact matches
  // for their own field. What separates them is the company the column keeps:
  // a sheet with "RFP ID", "Deadline" and "Est. Value" beside it is a pipeline,
  // and a sheet with "First Name" and "Email" beside it is a contact list.
  //
  // So the columns that match exactly one entity vote, and their votes tilt the
  // columns that match several. Only unambiguous columns vote, or the ambiguity
  // would be counting itself.
  const votes = new Map<ImportEntity, number>();
  const byColumn = new Map<number, Scored[]>();
  for (const candidate of scored) {
    byColumn.set(candidate.index, [...(byColumn.get(candidate.index) ?? []), candidate]);
  }
  for (const candidates of byColumn.values()) {
    const entities = new Set(candidates.map((c) => c.target.entity));
    if (entities.size !== 1) continue;
    const entity = [...entities][0]!;
    const best = Math.max(...candidates.map((c) => c.score));
    votes.set(entity, (votes.get(entity) ?? 0) + best);
  }
  const leadingVote = Math.max(0, ...votes.values());
  for (const candidate of scored) {
    if (leadingVote === 0) break;
    const share = (votes.get(candidate.target.entity) ?? 0) / leadingVote;
    // Deliberately small. This breaks ties between equally-good header matches;
    // it must never let a weak match beat a strong one from another entity.
    candidate.score += share * 0.08;
  }

  scored.sort((a, b) => b.score - a.score);

  const takenTarget = new Set<string>();
  const takenColumn = new Set<number>();
  const chosen = new Map<number, Scored>();
  for (const candidate of scored) {
    if (takenColumn.has(candidate.index)) continue;
    if (takenTarget.has(candidate.target.key)) continue;
    // Below this the header match is so weak it is noise.
    if (candidate.score < 0.45) continue;
    chosen.set(candidate.index, candidate);
    takenColumn.add(candidate.index);
    takenTarget.add(candidate.target.key);
  }

  return headers.map((header, index) => {
    const hit = chosen.get(index);
    const samples = sampleOf(index).filter((v) => v !== "").slice(0, 3);
    if (!hit) {
      return {
        index,
        header,
        targetKey: null,
        confidence: 0,
        reason: header.trim()
          ? "No field matched this header. It will not be imported unless you choose one."
          : "This column has no header.",
        samples,
        derived: false,
      };
    }
    return {
      index,
      header,
      targetKey: hit.target.key,
      confidence: Math.round(Math.min(1, hit.score) * 100) / 100,
      reason: hit.target.derived
        ? `${hit.reason} ${hit.target.hint ?? ""}`.trim()
        : hit.reason,
      samples,
      derived: hit.target.derived === true,
    };
  });
}

/** The entities a mapping will actually produce records for. */
export function entitiesInMapping(proposals: ColumnProposal[]): ImportEntity[] {
  const set = new Set<ImportEntity>();
  for (const p of proposals) {
    if (!p.targetKey) continue;
    const target = TARGETS_BY_KEY.get(p.targetKey);
    if (!target || target.derived) continue;
    set.add(target.entity);
    if (target.referenceTo) set.add(target.referenceTo);
  }
  return [...set];
}
