import "server-only";

import { contains, db, isSearchable } from "@/lib/db";
import { tagsForEntities } from "@/lib/actions/tags";
import { withTenantContext } from "@/lib/tenant-db";
import { parseJson } from "@/lib/json";

/**
 * Opportunity fit and go / no-go.
 *
 * Computed rather than model-generated so the recommendation is stable and
 * explainable: value, fit, strategic weight, competition and how much time is
 * actually left.
 */
export type GoNoGo = {
  recommendation: "go" | "lean_go" | "lean_no" | "no_bid";
  score: number;
  reasons: { label: string; detail: string; impact: number }[];
  summary: string;
  /**
   * Whether anyone has actually judged this opportunity yet.
   *
   * The scorer needs a human input to say anything meaningful: how well it
   * fits, how strategic it is, how contested. With none of those it is working
   * from the deadline and the contact count alone, and for a freshly imported
   * backlog that is every row — nobody has been contacted and the clock is
   * already running, so the model floors all of them. Measured against a real
   * tracker, an 82/GO closing in four days came out `no_bid`.
   *
   * That is not a recommendation, it is an absence of one, and presenting it
   * as "no bid" is worse than saying nothing: it argues against work the
   * person has already decided to pursue. The flag lets the UI say "not yet
   * assessed" and mean it. The arithmetic below is unchanged.
   */
  assessed: boolean;
};

export function assessOpportunity(input: {
  fitScore: number | null;
  strategicValue: string | null;
  competitionLevel: string | null;
  estimatedValueCents: number | null;
  deadlineAt: Date | null;
  submissionStatus: string;
  requirements: string | null;
  contactCount: number;
}): GoNoGo {
  const reasons: GoNoGo["reasons"] = [];
  let score = 50;

  if (input.fitScore !== null) {
    const impact = Math.round((input.fitScore - 50) / 2);
    score += impact;
    reasons.push({
      label: `Fit score ${input.fitScore}/100`,
      detail:
        input.fitScore >= 75
          ? "This is squarely the kind of work you do."
          : input.fitScore >= 50
            ? "A reasonable fit, with some stretch."
            : "Outside your usual scope — winning it would mean building something new.",
      impact,
    });
  }

  const strategic = { high: 15, medium: 5, low: -5 }[input.strategicValue ?? ""] ?? 0;
  if (strategic !== 0) {
    score += strategic;
    reasons.push({
      label: `${input.strategicValue} strategic value`,
      detail:
        strategic > 0
          ? "Winning this opens doors beyond the contract itself."
          : "Little strategic upside beyond the revenue.",
      impact: strategic,
    });
  }

  const competition = { low: 12, medium: 0, high: -14, unknown: -4 }[input.competitionLevel ?? ""] ?? 0;
  if (competition !== 0) {
    score += competition;
    reasons.push({
      label: `${input.competitionLevel} competition`,
      detail:
        competition > 0
          ? "A thin field improves the odds considerably."
          : "A crowded field means the proposal has to do more work.",
      impact: competition,
    });
  }

  const value = input.estimatedValueCents ?? 0;
  if (value >= 10_000_000) {
    score += 10;
    reasons.push({ label: "High value", detail: "Large enough to justify serious effort.", impact: 10 });
  } else if (value > 0 && value < 2_500_000) {
    score -= 6;
    reasons.push({
      label: "Modest value",
      detail: "The proposal effort may outweigh the contract.",
      impact: -6,
    });
  }

  // Time is the constraint that most often decides this in practice.
  const daysLeft = input.deadlineAt
    ? Math.ceil((input.deadlineAt.getTime() - Date.now()) / 86_400_000)
    : null;
  if (daysLeft !== null) {
    if (daysLeft < 0) {
      score -= 40;
      reasons.push({ label: "Deadline passed", detail: "The submission window has closed.", impact: -40 });
    } else if (daysLeft <= 5 && input.submissionStatus === "not_started") {
      score -= 20;
      reasons.push({
        label: "Very little time",
        detail: `${daysLeft} days left and nothing drafted.`,
        impact: -20,
      });
    } else if (daysLeft <= 14 && input.submissionStatus === "not_started") {
      score -= 8;
      reasons.push({
        label: "Tight timeline",
        detail: `${daysLeft} days left and drafting has not started.`,
        impact: -8,
      });
    }
  }

  if (input.contactCount === 0) {
    score -= 10;
    reasons.push({
      label: "No relationship",
      detail: "Cold solicitations are won far less often than warm ones.",
      impact: -10,
    });
  } else {
    score += 8;
    reasons.push({
      label: "You know someone here",
      detail: `${input.contactCount} contact(s) attached to this opportunity.`,
      impact: 8,
    });
  }

  score = Math.max(0, Math.min(100, score));

  const recommendation: GoNoGo["recommendation"] =
    score >= 70 ? "go" : score >= 55 ? "lean_go" : score >= 40 ? "lean_no" : "no_bid";

  const summary = {
    go: "Bid this. The fit and the odds justify the effort.",
    lean_go: "Worth bidding, but go in with a clear plan for the weak spots below.",
    lean_no: "Marginal. Bid only if you have capacity you would otherwise waste.",
    no_bid: "Skip it. The effort is better spent on something you can actually win.",
  }[recommendation];

  return {
    recommendation,
    score,
    reasons: reasons.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
    summary,
    // A judgement exists only if somebody supplied one. Deadline pressure and
    // contact count are circumstances, not an opinion about whether to bid.
    assessed:
      input.fitScore !== null ||
      input.strategicValue !== null ||
      input.competitionLevel !== null,
  };
}

export async function listOpportunities(
  workspaceIds: string[],
  filters: { q?: string; type?: string; submissionStatus?: string; view?: string },
) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    const now = new Date();
    const where: Record<string, unknown> = { workspaceId: { in: workspaceIds }, archivedAt: null };

    if (isSearchable(filters.q)) {
      where.OR = [
        { name: contains(filters.q) },
        { solicitationNumber: contains(filters.q) },
        { requirements: contains(filters.q) },
      ];
    }
    if (filters.type) where.type = filters.type;
    if (filters.submissionStatus) where.submissionStatus = filters.submissionStatus;
    if (filters.view === "open") where.submissionStatus = { notIn: ["won", "lost", "no_bid"] };
    if (filters.view === "due_soon") {
      where.submissionStatus = { notIn: ["won", "lost", "no_bid"] };
      where.deadlineAt = { gte: now, lte: new Date(now.getTime() + 30 * 86_400_000) };
    }
    if (filters.view === "submitted") where.submissionStatus = "submitted";

    const rows = await db.opportunity.findMany({
      where,
      select: {
        id: true, name: true, type: true, source: true, solicitationNumber: true,
        deadlineAt: true, questionsDeadlineAt: true, proposalDeadlineAt: true,
        estimatedValueCents: true, fitScore: true, strategicValue: true, competitionLevel: true,
        submissionStatus: true, requirements: true, workspaceId: true,
        company: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, color: true } },
        _count: { select: { contacts: true, tasks: true } },
      },
      orderBy: { deadlineAt: "asc" },
      take: 200,
    });

    const tags = await tagsForEntities("opportunity", rows.map((r) => r.id));

    return rows.map((o) => ({
      ...o,
      tags: tags.get(o.id) ?? [],
      assessment: assessOpportunity({
        fitScore: o.fitScore,
        strategicValue: o.strategicValue,
        competitionLevel: o.competitionLevel,
        estimatedValueCents: o.estimatedValueCents,
        deadlineAt: o.deadlineAt,
        submissionStatus: o.submissionStatus,
        requirements: o.requirements,
        contactCount: o._count.contacts,
      }),
    }));
  });
}

export async function getOpportunity(workspaceIds: string[], id: string) {
  // Read paths do not go through the action wrapper, so this is where they join
  // the RLS model. The ids are the caller's already-authorised scope
  // (resolveReadScope), so this narrows the database to exactly what the
  // application had already decided the request may see.
  return withTenantContext({ workspaceIds }, async () => {
    const opportunity = await db.opportunity.findFirst({
      where: { id, workspaceId: { in: workspaceIds } },
      include: {
        workspace: { select: { id: true, name: true } },
        company: { select: { id: true, name: true, industry: true } },
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        pipeline: {
          select: {
            id: true, name: true,
            stages: {
              select: { id: true, name: true, order: true, probability: true, color: true, kind: true },
              orderBy: { order: "asc" },
            },
          },
        },
        stage: { select: { id: true, name: true, color: true } },
        contacts: { include: { contact: { select: { id: true, fullName: true, jobTitle: true, email: true } } } },
        tasks: {
          select: { id: true, title: true, dueAt: true, priority: true, status: true },
          orderBy: [{ status: "asc" }, { dueAt: "asc" }],
        },
        notes: {
          select: { id: true, title: true, plainText: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 6,
        },
        activities: {
          select: {
            id: true, type: true, title: true, body: true, direction: true, occurredAt: true,
            contact: { select: { id: true, fullName: true } },
            company: { select: { id: true, name: true } },
          },
          orderBy: { occurredAt: "desc" },
          take: 25,
        },
        files: {
          select: { id: true, name: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!opportunity) return null;
    const tags = await tagsForEntities("opportunity", [id]);

    // What the spreadsheet said, if this record came from one.
    //
    // Kept beside Tiny's own assessment rather than replacing it. The source
    // score and verdict were true when the file was exported and are frozen;
    // Tiny's move as the deadline closes in. Showing one without the other
    // either throws away the working history or presents a stale number as
    // current, and both are worse than showing both and saying which is which.
    const source = opportunity.sourceBatchId
      ? await db.importRow
          .findFirst({
            where: {
              batch: { id: opportunity.sourceBatchId, workspaceId: opportunity.workspaceId },
              outcome: { contains: opportunity.id },
            },
            select: { raw: true, rowIndex: true, batch: { select: { sourceName: true, createdAt: true } } },
          })
          .catch(() => null)
      : null;

    return {
      ...opportunity,
      tags: tags.get(id) ?? [],
      importedFrom: source
        ? {
            fileName: source.batch.sourceName,
            importedAt: source.batch.createdAt,
            rowIndex: source.rowIndex,
            values: parseJson<Record<string, string>>(source.raw, {}),
          }
        : null,
      assessment: assessOpportunity({
        fitScore: opportunity.fitScore,
        strategicValue: opportunity.strategicValue,
        competitionLevel: opportunity.competitionLevel,
        estimatedValueCents: opportunity.estimatedValueCents,
        deadlineAt: opportunity.deadlineAt,
        submissionStatus: opportunity.submissionStatus,
        requirements: opportunity.requirements,
        contactCount: opportunity.contacts.length,
      }),
      // Requirements are stored as a block of text; split it so each one can be
      // shown as a checkable line item.
      requirementList: (opportunity.requirements ?? "")
        .split("\n")
        .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
        .filter(Boolean),
    };
  });
}
