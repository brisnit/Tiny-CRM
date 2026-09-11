import "server-only";

import { db } from "@/lib/db";
import { daysSince, formatDay, formatDayOnly, timeAgo } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { scoreDeal, scoreProjectHealth } from "@/lib/scoring";
import { truncate } from "@/lib/utils";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * CRM context retrieval.
 *
 * This is the only path by which business data reaches a model, and it enforces
 * three rules:
 *
 *   1. **Scope.** Every query is filtered to workspace ids the caller has
 *      already been authorised for. Context is never assembled from an id the
 *      user handed us.
 *   2. **Budget.** Context is capped and truncated field by field, so a
 *      workspace with 10,000 contacts produces the same size prompt as one with
 *      ten. Relevance selection happens in SQL, not by loading everything.
 *   3. **Shape.** Records are rendered as compact, labelled text with the
 *      deterministic scores already computed. The model reasons over facts we
 *      calculated rather than inventing its own arithmetic.
 */

export type ContextScope = { workspaceIds: string[]; workspaceNames: Map<string, string> };

const MAX_CHARS = 14_000;

export type CrmSnapshot = {
  text: string;
  /** Record ids included, so answers can be cited back to real records. */
  citations: { type: string; id: string; label: string }[];
  truncated: boolean;
};

function section(title: string, lines: string[]) {
  if (lines.length === 0) return "";
  return `## ${title}\n${lines.join("\n")}\n`;
}

/**
 * The working set for a general question: what is due, what is at risk, what has
 * gone quiet. Deliberately biased towards things that need attention rather
 * than a uniform sample of the database.
 */
export async function buildWorkspaceSnapshot(
  scope: ContextScope,
  options: { focus?: string | null; limit?: number } = {},
): Promise<CrmSnapshot> {
  // AI retrieval reads workspace data and is called from pages as well as from
  // actions, so it establishes its own context rather than relying on an ambient
  // one. Under RLS an unscoped read returns nothing, which for AI means a
  // confident answer built from an empty CRM.
  return withTenantContext({ workspaceIds: scope.workspaceIds }, async () => {
    const where = { workspaceId: { in: scope.workspaceIds } };
    const limit = options.limit ?? 12;
    const now = new Date();
    const citations: CrmSnapshot["citations"] = [];

    const ws = (id: string) => scope.workspaceNames.get(id) ?? "";

    const [tasks, deals, projects, contacts, opportunities, recentActivity, events, emails] =
      await Promise.all([
        db.task.findMany({
          where: { ...where, status: { in: ["open", "in_progress"] } },
          select: {
            id: true, title: true, dueAt: true, priority: true, workspaceId: true,
            project: { select: { name: true } }, deal: { select: { name: true } },
            contact: { select: { fullName: true } },
          },
          orderBy: [{ dueAt: "asc" }],
          take: limit * 2,
        }),
        db.deal.findMany({
          where: { ...where, archivedAt: null, stage: { kind: "open" } },
          select: {
            id: true, name: true, valueCents: true, expectedCloseAt: true, nextStep: true,
            createdAt: true, stageEnteredAt: true, lastActivityAt: true, workspaceId: true,
            company: { select: { name: true } },
            stage: { select: { name: true, probability: true, kind: true, order: true, pipeline: { select: { stages: { select: { id: true } } } } } },
            _count: { select: { contacts: true, tasks: true } },
          },
          orderBy: [{ valueCents: "desc" }],
          take: limit * 2,
        }),
        db.project.findMany({
          where: { ...where, archivedAt: null, status: { isTerminal: false } },
          select: {
            id: true, name: true, health: true, targetDate: true, nextAction: true,
            lastActivityAt: true, completedAt: true, revenueCents: true, budgetCents: true,
            workspaceId: true,
            company: { select: { name: true } }, status: { select: { name: true, isTerminal: true } },
            milestones: { select: { completedAt: true, dueDate: true } },
            tasks: { where: { status: { in: ["open", "in_progress"] } }, select: { dueAt: true } },
          },
          orderBy: { targetDate: "asc" },
          take: limit * 2,
        }),
        db.contact.findMany({
          where: {
            ...where, archivedAt: null,
            OR: [
              { nextFollowUpAt: { lte: now } },
              { lastContactedAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } },
            ],
          },
          select: {
            id: true, fullName: true, jobTitle: true, lastContactedAt: true,
            nextFollowUpAt: true, relationshipType: true, workspaceId: true,
            company: { select: { name: true } },
          },
          orderBy: { nextFollowUpAt: "asc" },
          take: limit,
        }),
        db.opportunity.findMany({
          where: { ...where, archivedAt: null, submissionStatus: { notIn: ["won", "lost", "no_bid"] } },
          select: {
            id: true, name: true, deadlineAt: true, estimatedValueCents: true, fitScore: true,
            submissionStatus: true, type: true, workspaceId: true, company: { select: { name: true } },
          },
          orderBy: { deadlineAt: "asc" },
          take: limit,
        }),
        db.activity.findMany({
          where: { ...where, occurredAt: { gte: new Date(now.getTime() - 14 * 86_400_000) } },
          select: {
            id: true, type: true, title: true, body: true, occurredAt: true, workspaceId: true,
            contact: { select: { fullName: true } }, company: { select: { name: true } },
            deal: { select: { name: true } }, project: { select: { name: true } },
          },
          orderBy: { occurredAt: "desc" },
          take: limit * 2,
        }),
        db.calendarEvent.findMany({
          where: { ...where, startAt: { gte: now, lte: new Date(now.getTime() + 7 * 86_400_000) } },
          select: {
            id: true, title: true, startAt: true, workspaceId: true,
            contact: { select: { fullName: true } }, project: { select: { name: true } },
          },
          orderBy: { startAt: "asc" },
          take: limit,
        }),
        db.emailMessage.findMany({
          where: { ...where, needsReply: true },
          select: {
            id: true, subject: true, snippet: true, sentAt: true, direction: true,
            workspaceId: true, contact: { select: { fullName: true } },
          },
          orderBy: { sentAt: "desc" },
          take: 8,
        }),
      ]);

    const taskLines = tasks.slice(0, limit).map((t) => {
      const overdue = t.dueAt && t.dueAt < now;
      const link = [t.project?.name, t.deal?.name, t.contact?.fullName].filter(Boolean).join(" / ");
      citations.push({ type: "task", id: t.id, label: t.title });
      return `- [${t.priority}] ${t.title}${link ? ` (${link})` : ""} — due ${formatDayOnly(t.dueAt, "no date")}${overdue ? " ⚠ OVERDUE" : ""} [${ws(t.workspaceId)}]`;
    });

    const dealLines = deals.slice(0, limit).map((d) => {
      const stageCount = d.stage.pipeline.stages.length || 1;
      const intel = scoreDeal({
        createdAt: d.createdAt,
        stageEnteredAt: d.stageEnteredAt,
        lastActivityAt: d.lastActivityAt,
        expectedCloseAt: d.expectedCloseAt,
        stageProgress: d.stage.order / stageCount,
        stageProbability: d.stage.probability,
        stageKind: "open",
        valueCents: d.valueCents,
        activities30d: 0,
        inbound30d: 0,
        meetings30d: 0,
        openTasks: d._count.tasks,
        hasNextStep: Boolean(d.nextStep),
        contactCount: d._count.contacts,
      });
      citations.push({ type: "deal", id: d.id, label: d.name });
      return `- ${d.name} — ${formatMoney(d.valueCents)}, stage ${d.stage.name}, win ~${intel.winProbability}%, momentum ${intel.momentum.value}, last activity ${timeAgo(d.lastActivityAt)}, closes ${formatDayOnly(d.expectedCloseAt, "unset")}${d.company ? `, ${d.company.name}` : ""}${d.nextStep ? `. Next: ${truncate(d.nextStep, 90)}` : ". No next step."}${intel.risks.length ? ` Risks: ${intel.risks.join("; ")}` : ""} [${ws(d.workspaceId)}]`;
    });

    const projectLines = projects.slice(0, limit).map((p) => {
      const overdueTasks = p.tasks.filter((t) => t.dueAt && t.dueAt < now).length;
      const health = scoreProjectHealth({
        targetDate: p.targetDate,
        completedAt: p.completedAt,
        lastActivityAt: p.lastActivityAt,
        isTerminalStatus: p.status?.isTerminal ?? false,
        overdueTasks,
        openTasks: p.tasks.length,
        totalMilestones: p.milestones.length,
        completedMilestones: p.milestones.filter((m) => m.completedAt).length,
        overdueMilestones: p.milestones.filter((m) => !m.completedAt && m.dueDate && m.dueDate < now).length,
        budgetCents: p.budgetCents,
        revenueCents: p.revenueCents,
        hasNextAction: Boolean(p.nextAction),
      });
      citations.push({ type: "project", id: p.id, label: p.name });
      return `- ${p.name}${p.company ? ` (${p.company.name})` : ""} — ${p.status?.name ?? "no status"}, health ${health.value}, due ${formatDayOnly(p.targetDate, "unset")}, ${p.tasks.length} open task(s)${overdueTasks ? `, ${overdueTasks} overdue` : ""}, last activity ${timeAgo(p.lastActivityAt)}${p.nextAction ? `. Next: ${truncate(p.nextAction, 90)}` : ". No next action set."} [${ws(p.workspaceId)}]`;
    });

    const contactLines = contacts.map((c) => {
      const since = daysSince(c.lastContactedAt);
      citations.push({ type: "contact", id: c.id, label: c.fullName });
      return `- ${c.fullName}${c.jobTitle ? `, ${c.jobTitle}` : ""}${c.company ? ` at ${c.company.name}` : ""} — ${c.relationshipType}, last contact ${since === null ? "never" : `${since}d ago`}${c.nextFollowUpAt && c.nextFollowUpAt < now ? `, follow-up OVERDUE since ${formatDayOnly(c.nextFollowUpAt)}` : ""} [${ws(c.workspaceId)}]`;
    });

    const oppLines = opportunities.map((o) => {
      citations.push({ type: "opportunity", id: o.id, label: o.name });
      return `- ${o.name}${o.company ? ` (${o.company.name})` : ""} — ${o.type.toUpperCase()}, ${formatMoney(o.estimatedValueCents)}, fit ${o.fitScore ?? "?"}/100, status ${o.submissionStatus}, deadline ${formatDayOnly(o.deadlineAt, "unset")} [${ws(o.workspaceId)}]`;
    });

    const activityLines = recentActivity.slice(0, limit).map((a) => {
      const link = [a.contact?.fullName, a.company?.name, a.deal?.name, a.project?.name].filter(Boolean).join(" / ");
      return `- ${formatDay(a.occurredAt)}: [${a.type}] ${a.title}${link ? ` — ${link}` : ""}${a.body ? `. ${truncate(a.body, 140)}` : ""}`;
    });

    const eventLines = events.map(
      (e) => `- ${formatDay(e.startAt)}: ${e.title}${e.contact ? ` with ${e.contact.fullName}` : ""}${e.project ? ` (${e.project.name})` : ""}`,
    );

    const emailLines = emails.map(
      (e) => `- ${formatDay(e.sentAt)}: "${e.subject}" ${e.direction === "outbound" ? "sent to" : "from"} ${e.contact?.fullName ?? "unknown"} — awaiting reply. ${truncate(e.snippet, 100)}`,
    );

    let text = [
      section("Open tasks", taskLines),
      section("Open deals", dealLines),
      section("Active projects", projectLines),
      section("Contacts needing attention", contactLines),
      section("Opportunities in flight", oppLines),
      section("Meetings in the next 7 days", eventLines),
      section("Emails awaiting a reply", emailLines),
      section("Recent activity", activityLines),
    ]
      .filter(Boolean)
      .join("\n");

    const truncated = text.length > MAX_CHARS;
    if (truncated) text = `${text.slice(0, MAX_CHARS)}\n\n[Context truncated — showing the most urgent records.]`;

    return { text, citations, truncated };
  });
}

/** Everything relevant to one record, for a record-level summary. */
export async function buildRecordContext(
  scope: ContextScope,
  entityType: "contact" | "company" | "deal" | "project" | "opportunity",
  entityId: string,
): Promise<CrmSnapshot | null> {
  // AI retrieval reads workspace data and is called from pages as well as from
  // actions, so it establishes its own context rather than relying on an ambient
  // one. Under RLS an unscoped read returns nothing, which for AI means a
  // confident answer built from an empty CRM.
  return withTenantContext({ workspaceIds: scope.workspaceIds }, async () => {
    const inScope = { workspaceId: { in: scope.workspaceIds } };
    const citations: CrmSnapshot["citations"] = [];

    const [activities, tasks, notes] = await Promise.all([
      db.activity.findMany({
        where: { ...inScope, [`${entityType}Id`]: entityId },
        select: { type: true, title: true, body: true, occurredAt: true, direction: true, durationMin: true },
        orderBy: { occurredAt: "desc" },
        take: 25,
      }),
      db.task.findMany({
        where: { ...inScope, [`${entityType}Id`]: entityId },
        select: { title: true, status: true, dueAt: true, priority: true },
        orderBy: [{ status: "asc" }, { dueAt: "asc" }],
        take: 20,
      }),
      db.note.findMany({
        where: { ...inScope, [`${entityType}Id`]: entityId },
        select: { title: true, plainText: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

    const header = await describeEntity(scope, entityType, entityId);
    if (!header) return null;
    citations.push({ type: entityType, id: entityId, label: header.label });

    const text = [
      `## Record\n${header.detail}\n`,
      section(
        "Notes",
        notes.map((n) => `- ${formatDay(n.createdAt)} — ${n.title ?? "Untitled"}: ${truncate(n.plainText, 500)}`),
      ),
      section(
        "Timeline",
        activities.map(
          (a) =>
            `- ${formatDay(a.occurredAt)} [${a.type}${a.direction ? `/${a.direction}` : ""}] ${a.title}${a.durationMin ? ` (${a.durationMin}m)` : ""}${a.body ? `: ${truncate(a.body, 220)}` : ""}`,
        ),
      ),
      section(
        "Tasks",
        tasks.map((t) => `- [${t.status}] ${t.title} — due ${formatDayOnly(t.dueAt, "no date")} (${t.priority})`),
      ),
    ]
      .filter(Boolean)
      .join("\n");

    return { text: text.slice(0, MAX_CHARS), citations, truncated: text.length > MAX_CHARS };
  });
}

async function describeEntity(
  scope: ContextScope,
  entityType: string,
  id: string,
): Promise<{ label: string; detail: string } | null> {
  const inScope = { workspaceId: { in: scope.workspaceIds } };
  const now = new Date();

  switch (entityType) {
    case "contact": {
      const c = await db.contact.findFirst({
        where: { id, ...inScope },
        include: {
          company: { select: { name: true, industry: true } },
          _count: { select: { deals: true, projects: true } },
        },
      });
      if (!c) return null;
      return {
        label: c.fullName,
        detail: [
          `Name: ${c.fullName}`,
          c.jobTitle && `Title: ${c.jobTitle}`,
          c.company && `Company: ${c.company.name}${c.company.industry ? ` (${c.company.industry})` : ""}`,
          `Relationship: ${c.relationshipType}`,
          c.email && `Email: ${c.email}`,
          c.location && `Location: ${c.location}`,
          `Last contacted: ${c.lastContactedAt ? `${daysSince(c.lastContactedAt)} days ago` : "never"}`,
          c.nextFollowUpAt && `Next follow-up: ${formatDayOnly(c.nextFollowUpAt)}${c.nextFollowUpAt < now ? " (OVERDUE)" : ""}`,
          `Linked to ${c._count.deals} deal(s) and ${c._count.projects} project(s)`,
          `Known for ${daysSince(c.createdAt)} days`,
        ].filter(Boolean).join("\n"),
      };
    }
    case "company": {
      const c = await db.company.findFirst({
        where: { id, ...inScope },
        include: {
          primaryContact: { select: { fullName: true, jobTitle: true } },
          _count: { select: { contacts: true, deals: true, projects: true } },
        },
      });
      if (!c) return null;
      return {
        label: c.name,
        detail: [
          `Company: ${c.name}`,
          c.industry && `Industry: ${c.industry}`,
          c.size && `Size: ${c.size}`,
          c.location && `Location: ${c.location}`,
          `Type: ${c.type ?? "unknown"} · Status: ${c.relationshipStatus}`,
          c.primaryContact && `Primary contact: ${c.primaryContact.fullName}${c.primaryContact.jobTitle ? `, ${c.primaryContact.jobTitle}` : ""}`,
          `${c._count.contacts} contact(s), ${c._count.deals} deal(s), ${c._count.projects} project(s)`,
          `Last activity: ${timeAgo(c.lastActivityAt)}`,
          c.description && `About: ${truncate(c.description, 300)}`,
        ].filter(Boolean).join("\n"),
      };
    }
    case "deal": {
      const d = await db.deal.findFirst({
        where: { id, ...inScope },
        include: {
          company: { select: { name: true } },
          primaryContact: { select: { fullName: true, jobTitle: true } },
          stage: { select: { name: true, probability: true, kind: true, order: true } },
          project: { select: { name: true } },
          _count: { select: { contacts: true, tasks: true } },
        },
      });
      if (!d) return null;
      return {
        label: d.name,
        detail: [
          `Deal: ${d.name}`,
          `Value: ${formatMoney(d.valueCents)}`,
          `Stage: ${d.stage.name} (base win rate ${d.stage.probability}%)`,
          `In this stage for ${daysSince(d.stageEnteredAt)} days`,
          d.company && `Company: ${d.company.name}`,
          d.primaryContact && `Primary contact: ${d.primaryContact.fullName}${d.primaryContact.jobTitle ? `, ${d.primaryContact.jobTitle}` : ""}`,
          d.project && `Project: ${d.project.name}`,
          `Expected close: ${formatDayOnly(d.expectedCloseAt, "not set")}`,
          `Last activity: ${timeAgo(d.lastActivityAt)}`,
          d.nextStep ? `Next step: ${d.nextStep}` : "No next step defined.",
          `${d._count.contacts} contact(s) involved, ${d._count.tasks} task(s)`,
        ].filter(Boolean).join("\n"),
      };
    }
    case "project": {
      const p = await db.project.findFirst({
        where: { id, ...inScope },
        include: {
          company: { select: { name: true } },
          status: { select: { name: true } },
          milestones: { select: { name: true, dueDate: true, completedAt: true }, orderBy: { order: "asc" } },
          _count: { select: { tasks: true, contacts: true, deals: true } },
        },
      });
      if (!p) return null;
      return {
        label: p.name,
        detail: [
          `Project: ${p.name}`,
          p.company && `Client: ${p.company.name}`,
          `Status: ${p.status?.name ?? "none"} · Priority: ${p.priority} · Health: ${p.health}`,
          p.description && `About: ${truncate(p.description, 400)}`,
          `Target date: ${formatDayOnly(p.targetDate, "not set")}`,
          p.budgetCents && `Budget: ${formatMoney(p.budgetCents)}`,
          p.revenueCents && `Revenue: ${formatMoney(p.revenueCents)}`,
          p.nextAction ? `Next action: ${p.nextAction}` : "No next action set.",
          `Last activity: ${timeAgo(p.lastActivityAt)}`,
          `Milestones: ${p.milestones.map((m) => `${m.name} (${m.completedAt ? "done" : `due ${formatDayOnly(m.dueDate, "unset")}`})`).join("; ")}`,
        ].filter(Boolean).join("\n"),
      };
    }
    case "opportunity": {
      const o = await db.opportunity.findFirst({
        where: { id, ...inScope },
        include: { company: { select: { name: true } } },
      });
      if (!o) return null;
      return {
        label: o.name,
        detail: [
          `Opportunity: ${o.name}`,
          o.company && `Organization: ${o.company.name}`,
          `Type: ${o.type} · Submission status: ${o.submissionStatus}`,
          o.solicitationNumber && `Solicitation: ${o.solicitationNumber}`,
          `Estimated value: ${formatMoney(o.estimatedValueCents)}`,
          o.fitScore !== null && `Fit score: ${o.fitScore}/100`,
          o.strategicValue && `Strategic value: ${o.strategicValue}`,
          o.competitionLevel && `Competition: ${o.competitionLevel}`,
          o.questionsDeadlineAt && `Questions due: ${formatDayOnly(o.questionsDeadlineAt)}`,
          `Proposal due: ${formatDayOnly(o.proposalDeadlineAt ?? o.deadlineAt, "not set")}`,
          o.requirements && `Requirements:\n${truncate(o.requirements, 1800)}`,
        ].filter(Boolean).join("\n"),
      };
    }
    default:
      return null;
  }
}
