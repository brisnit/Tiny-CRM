import "server-only";

import { db } from "@/lib/db";
import { daysSince } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { ContextScope } from "@/lib/ai/context";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * CRM hygiene detection.
 *
 * These checks are deterministic rather than model-driven: finding two contacts
 * with the same email, or a deal with no next step, is a query, not a judgement
 * call. Running them in SQL means they are exact, instant, free, and identical
 * whether or not an API key is configured.
 *
 * SCALE NOTE — the first version of this file loaded every contact, company and
 * open deal into memory to find duplicates. A load test (scripts/loadtest.ts)
 * measured that at 873ms on a 25,000-contact workspace, growing linearly, while
 * every other query in the app stayed under 40ms. It is now written so the
 * database does the grouping and every scan is bounded: duplicates are found
 * with GROUP BY … HAVING COUNT(*) > 1, and each detector takes a capped slice
 * ordered by how much it matters. Cost is now a function of how many *problems*
 * a workspace has, not how many records.
 */

export type Recommendation = {
  id: string;
  kind:
    | "duplicate_contact" | "duplicate_company" | "missing_company" | "stale_deal"
    | "no_next_step" | "overdue_followup" | "task_no_due_date" | "unlinked_project"
    | "deadline_soon" | "unanswered_email" | "orphan_contact";
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  entityType: string;
  entityIds: string[];
  /** What the one-click fix would do, if there is one. */
  action?: { label: string; type: string; payload: Record<string, unknown> };
};

/** Per-detector cap. A user cannot act on more than a handful of each anyway. */
const PER_CHECK = 12;

export async function findRecommendations(scope: ContextScope, limit = 25): Promise<Recommendation[]> {
  // AI retrieval reads workspace data and is called from pages as well as from
  // actions, so it establishes its own context rather than relying on an ambient
  // one. Under RLS an unscoped read returns nothing, which for AI means a
  // confident answer built from an empty CRM.
  return withTenantContext({ workspaceIds: scope.workspaceIds }, async () => {
    const where = { workspaceId: { in: scope.workspaceIds } };
    const now = new Date();
    const out: Recommendation[] = [];

    const [
      duplicateEmails, duplicateNames, duplicateCompanies, unlinkedContacts,
      staleDeals, dealsWithoutNextStep, overdueFollowUps, orphanCandidates,
      undatedTasks, nearDeadlines, unansweredEmails,
    ] = await Promise.all([
      // --- Duplicates: grouped in SQL, so only the colliding rows come back ----
      db.contact.groupBy({
        by: ["email"],
        where: { ...where, archivedAt: null, email: { not: null } },
        _count: { _all: true },
        having: { email: { _count: { gt: 1 } } },
        orderBy: { email: "asc" },
        take: PER_CHECK,
      }),
      db.contact.groupBy({
        by: ["fullName"],
        where: { ...where, archivedAt: null },
        _count: { _all: true },
        having: { fullName: { _count: { gt: 1 } } },
        orderBy: { fullName: "asc" },
        take: PER_CHECK,
      }),
      db.company.groupBy({
        by: ["name"],
        where: { ...where, archivedAt: null },
        _count: { _all: true },
        having: { name: { _count: { gt: 1 } } },
        orderBy: { name: "asc" },
        take: PER_CHECK,
      }),

      // --- Missing relationships: only contacts that could possibly match ------
      db.contact.findMany({
        where: { ...where, archivedAt: null, companyId: null, email: { not: null } },
        select: { id: true, fullName: true, email: true },
        take: 200,
      }),

      // --- Deals ---------------------------------------------------------------
      db.deal.findMany({
        where: {
          ...where, archivedAt: null, stage: { kind: "open" },
          OR: [{ lastActivityAt: { lte: new Date(now.getTime() - 14 * 86_400_000) } }, { lastActivityAt: null }],
        },
        select: {
          id: true, name: true, valueCents: true, lastActivityAt: true,
          company: { select: { name: true } },
        },
        orderBy: [{ lastActivityAt: "asc" }, { valueCents: "desc" }],
        take: PER_CHECK,
      }),
      db.deal.findMany({
        where: { ...where, archivedAt: null, stage: { kind: "open" }, nextStep: null },
        select: { id: true, name: true, valueCents: true },
        orderBy: { valueCents: "desc" },
        take: PER_CHECK,
      }),

      // --- Follow-ups and hygiene ----------------------------------------------
      db.contact.findMany({
        where: { ...where, archivedAt: null, nextFollowUpAt: { lt: now } },
        select: {
          id: true, fullName: true, nextFollowUpAt: true,
          _count: { select: { deals: true } },
        },
        orderBy: { nextFollowUpAt: "asc" },
        take: PER_CHECK,
      }),
      db.contact.findMany({
        where: {
          ...where, archivedAt: null,
          createdAt: { lte: new Date(now.getTime() - 30 * 86_400_000) },
          activities: { none: {} },
          deals: { none: {} },
          projects: { none: {} },
        },
        select: { id: true, fullName: true },
        take: PER_CHECK,
      }),
      db.task.findMany({
        where: { ...where, status: { in: ["open", "in_progress"] }, dueAt: null },
        select: { id: true, title: true },
        take: PER_CHECK,
      }),
      db.opportunity.findMany({
        where: {
          ...where, archivedAt: null,
          submissionStatus: { notIn: ["won", "lost", "no_bid", "submitted"] },
          deadlineAt: { gte: now, lte: new Date(now.getTime() + 10 * 86_400_000) },
        },
        select: { id: true, name: true, deadlineAt: true, submissionStatus: true },
        orderBy: { deadlineAt: "asc" },
        take: PER_CHECK,
      }),
      db.emailMessage.findMany({
        where: { ...where, needsReply: true, sentAt: { lte: new Date(now.getTime() - 3 * 86_400_000) } },
        select: { id: true, subject: true, sentAt: true, contact: { select: { id: true, fullName: true } } },
        orderBy: { sentAt: "asc" },
        take: PER_CHECK,
      }),
    ]);

    // Resolve the duplicate groups into actual records — a second query, but only
    // over the handful of values that actually collided.
    const dupEmails = duplicateEmails.map((g) => g.email!).filter(Boolean);
    const dupNames = duplicateNames.map((g) => g.fullName);
    const dupCompanyNames = duplicateCompanies.map((g) => g.name);

    const [emailDupRecords, nameDupRecords, companyDupRecords, domainCompanies] = await Promise.all([
      dupEmails.length
        ? db.contact.findMany({
            where: { ...where, archivedAt: null, email: { in: dupEmails } },
            select: { id: true, fullName: true, email: true },
          })
        : [],
      dupNames.length
        ? db.contact.findMany({
            where: { ...where, archivedAt: null, fullName: { in: dupNames } },
            select: { id: true, fullName: true, email: true },
          })
        : [],
      dupCompanyNames.length
        ? db.company.findMany({
            where: { ...where, archivedAt: null, name: { in: dupCompanyNames } },
            select: { id: true, name: true },
          })
        : [],
      // Only the domains that unlinked contacts actually use.
      unlinkedContacts.length
        ? db.company.findMany({
            where: {
              ...where, archivedAt: null,
              domain: {
                in: Array.from(
                  new Set(
                    unlinkedContacts
                      .map((c) => c.email?.split("@")[1]?.toLowerCase())
                      .filter((d): d is string => Boolean(d)),
                  ),
                ),
              },
            },
            select: { id: true, name: true, domain: true },
          })
        : [],
    ]);

    const groupBy = <T>(items: T[], key: (item: T) => string) => {
      const map = new Map<string, T[]>();
      for (const item of items) {
        const k = key(item);
        map.set(k, [...(map.get(k) ?? []), item]);
      }
      return map;
    };

    for (const [email, group] of groupBy(emailDupRecords, (c) => c.email!.toLowerCase())) {
      if (group.length < 2) continue;
      out.push({
        id: `dup-contact-email-${email}`,
        kind: "duplicate_contact",
        severity: "high",
        title: `${group.length} contacts share the email ${email}`,
        detail: group.map((c) => c.fullName).join(", "),
        entityType: "contact",
        entityIds: group.map((c) => c.id),
        action: { label: "Review duplicates", type: "review_duplicates", payload: { ids: group.map((c) => c.id) } },
      });
    }

    for (const [, group] of groupBy(nameDupRecords, (c) => c.fullName.toLowerCase())) {
      if (group.length < 2) continue;
      // Skip when the email duplicate check already covers this exact set.
      const emails = new Set(group.map((c) => c.email?.toLowerCase() ?? ""));
      if (emails.size === 1 && !emails.has("")) continue;
      out.push({
        id: `dup-contact-name-${group[0]!.id}`,
        kind: "duplicate_contact",
        severity: "medium",
        title: `Possible duplicate: ${group[0]!.fullName}`,
        detail: `${group.length} contacts share this name. Merge them if they are the same person.`,
        entityType: "contact",
        entityIds: group.map((c) => c.id),
        action: { label: "Review duplicates", type: "review_duplicates", payload: { ids: group.map((c) => c.id) } },
      });
    }

    for (const [, group] of groupBy(companyDupRecords, (c) => c.name.toLowerCase())) {
      if (group.length < 2) continue;
      out.push({
        id: `dup-company-${group[0]!.id}`,
        kind: "duplicate_company",
        severity: "medium",
        title: `Duplicate company: ${group[0]!.name}`,
        detail: `${group.length} records share this name.`,
        entityType: "company",
        entityIds: group.map((c) => c.id),
      });
    }

    const byDomain = new Map(domainCompanies.map((c) => [c.domain!.toLowerCase(), c]));
    for (const contact of unlinkedContacts) {
      const domain = contact.email?.split("@")[1]?.toLowerCase();
      const match = domain ? byDomain.get(domain) : null;
      if (!match) continue;
      out.push({
        id: `link-company-${contact.id}`,
        kind: "missing_company",
        severity: "medium",
        title: `${contact.fullName} is probably at ${match.name}`,
        detail: `Their email domain (${domain}) matches ${match.name}, but they are not linked.`,
        entityType: "contact",
        entityIds: [contact.id],
        action: {
          label: `Link to ${match.name}`,
          type: "link_company",
          payload: { contactId: contact.id, companyId: match.id },
        },
      });
      if (out.filter((r) => r.kind === "missing_company").length >= PER_CHECK) break;
    }

    for (const deal of staleDeals) {
      const quiet = daysSince(deal.lastActivityAt);
      out.push({
        id: `stale-deal-${deal.id}`,
        kind: "stale_deal",
        severity: quiet !== null && quiet >= 30 ? "high" : "medium",
        title: `${deal.name} has gone quiet`,
        detail: `${formatMoney(deal.valueCents)}${deal.company ? ` with ${deal.company.name}` : ""} — ${quiet === null ? "no activity ever logged" : `${quiet} days since the last activity`}.`,
        entityType: "deal",
        entityIds: [deal.id],
        action: {
          label: "Create a follow-up task",
          type: "create_task",
          payload: { dealId: deal.id, title: `Re-engage: ${deal.name}`, dueInDays: 1 },
        },
      });
    }

    for (const deal of dealsWithoutNextStep) {
      out.push({
        id: `no-next-step-${deal.id}`,
        kind: "no_next_step",
        severity: "medium",
        title: `${deal.name} has no next step`,
        detail: "Deals without a defined next step drift. Add one with a date.",
        entityType: "deal",
        entityIds: [deal.id],
      });
    }

    for (const contact of overdueFollowUps) {
      const overdue = daysSince(contact.nextFollowUpAt) ?? 0;
      out.push({
        id: `overdue-followup-${contact.id}`,
        kind: "overdue_followup",
        severity: overdue > 14 ? "high" : "medium",
        title: `Follow-up with ${contact.fullName} is ${overdue} day${overdue === 1 ? "" : "s"} overdue`,
        detail: contact._count.deals > 0 ? `They have ${contact._count.deals} open deal(s).` : "You set a reminder and it passed.",
        entityType: "contact",
        entityIds: [contact.id],
        action: {
          label: "Create a task",
          type: "create_task",
          payload: { contactId: contact.id, title: `Follow up with ${contact.fullName}`, dueInDays: 0 },
        },
      });
    }

    for (const contact of orphanCandidates) {
      out.push({
        id: `orphan-${contact.id}`,
        kind: "orphan_contact",
        severity: "low",
        title: `${contact.fullName} is not connected to anything`,
        detail: "No activity, deals or projects in over a month. Archive them or give them a next step.",
        entityType: "contact",
        entityIds: [contact.id],
      });
    }

    for (const task of undatedTasks) {
      out.push({
        id: `no-due-${task.id}`,
        kind: "task_no_due_date",
        severity: "low",
        title: `“${task.title}” has no due date`,
        detail: "Tasks without a date do not show up when they matter.",
        entityType: "task",
        entityIds: [task.id],
      });
    }

    for (const opportunity of nearDeadlines) {
      const days = Math.max(0, Math.ceil(((opportunity.deadlineAt?.getTime() ?? 0) - now.getTime()) / 86_400_000));
      out.push({
        id: `deadline-${opportunity.id}`,
        kind: "deadline_soon",
        severity: days <= 3 ? "high" : "medium",
        title: `${opportunity.name} is due in ${days} day${days === 1 ? "" : "s"}`,
        detail: `Submission status is still “${opportunity.submissionStatus.replace(/_/g, " ")}”.`,
        entityType: "opportunity",
        entityIds: [opportunity.id],
      });
    }

    for (const email of unansweredEmails) {
      const days = daysSince(email.sentAt) ?? 0;
      out.push({
        id: `email-${email.id}`,
        kind: "unanswered_email",
        severity: days > 10 ? "high" : "low",
        title: `“${email.subject}” is still waiting on a reply`,
        detail: `${days} days${email.contact ? ` — ${email.contact.fullName}` : ""}.`,
        entityType: "contact",
        entityIds: email.contact ? [email.contact.id] : [],
      });
    }

    const rank = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, limit);
  });
}
