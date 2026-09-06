/**
 * Performance regression suite.
 *
 * Builds a workspace at a chosen scale in a throwaway database, times the
 * queries that actually back the app's screens, and **fails** if any of them
 * crosses its budget. This is a test, not a report: a change that turns an
 * indexed range scan into a table scan should break the build rather than be
 * noticed by a customer.
 *
 *   npm run test:perf              # 25k contacts / 100k activities
 *   npm run test:perf -- --tier=xl # 100k contacts / 500k activities
 *
 * Budgets are wall-clock at the data-access layer on a developer laptop against
 * SQLite. They are deliberately generous — the point is to catch an order of
 * magnitude, not a 20% drift, which would make the suite flaky. Numbers on
 * managed PostgreSQL differ; see docs/DEPLOYMENT-CHECKLIST.md for how to
 * re-baseline against the real engine.
 */
import { performance } from "node:perf_hooks";

import { db } from "@/lib/db";
import { getDashboard } from "@/lib/data/dashboard";
import { listContacts } from "@/lib/data/contacts";
import { listProjects } from "@/lib/data/projects";
import { getPipelineBoard } from "@/lib/data/deals";
import { getAnalytics } from "@/lib/data/analytics";
import { searchEverything } from "@/lib/data/search";
import { findRecommendations } from "@/lib/ai/recommendations";
import { buildWorkspaceSnapshot } from "@/lib/ai/context";

type Tier = {
  name: string;
  contacts: number;
  companies: number;
  projects: number;
  deals: number;
  tasks: number;
  activities: number;
  /** Multiplier applied to every budget, since some costs grow with the data. */
  budgetScale: number;
};

const TIERS: Record<string, Tier> = {
  // "A busy year for a small agency, times five."
  standard: {
    name: "standard",
    contacts: 25_000, companies: 3_000, projects: 500,
    deals: 12_000, tasks: 20_000, activities: 100_000,
    budgetScale: 1,
  },
  // The stated ceiling: four times the data on the same schema and indexes.
  xl: {
    name: "xl",
    contacts: 100_000, companies: 10_000, projects: 2_000,
    deals: 50_000, tasks: 80_000, activities: 500_000,
    budgetScale: 3,
  },
};

/** Budget in milliseconds at the `standard` tier. */
const BUDGETS: Record<string, number> = {
  "Dashboard (home)": 250,
  "Contacts list, page 1": 250,
  "Contacts list, deep page": 400,
  "Contacts search": 400,
  "Contacts: needs follow-up": 250,
  "Projects list": 250,
  "Pipeline board": 300,
  "Analytics (90 days)": 400,
  "Analytics (1 year)": 600,
  "Global search": 500,
  "AI context snapshot": 400,
  "AI cleanup scan": 400,
};

const tierName = (process.argv.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "standard");
const tier = TIERS[tierName];
if (!tier) {
  console.error(`Unknown tier "${tierName}". Use one of: ${Object.keys(TIERS).join(", ")}`);
  process.exit(2);
}

const rand = (n: number) => Math.floor(Math.random() * n);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function seed() {
  const user = await db.user.create({
    data: { email: `perf-${Date.now()}@test.local`, name: "Perf Runner" },
  });

  const workspace = await db.workspace.create({
    data: {
      name: "Perf", slug: `perf-${Date.now()}`, ownerId: user.id,
      members: { create: { userId: user.id, role: "owner" } },
      projectStatuses: {
        create: ["Idea", "Active", "Waiting", "Completed"].map((name, i) => ({
          key: name.toLowerCase(), name, order: i,
          isTerminal: name === "Completed", isDefault: name === "Active",
        })),
      },
    },
    include: { projectStatuses: true },
  });

  const pipeline = await db.pipeline.create({
    data: {
      workspaceId: workspace.id, name: "Sales", kind: "deal", isDefault: true,
      stages: {
        create: ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"].map((name, i) => ({
          name, order: i, probability: i * 20,
          kind: name === "Won" ? "won" : name === "Lost" ? "lost" : "open",
        })),
      },
    },
    include: { stages: { orderBy: { order: "asc" } } },
  });

  const ws = workspace.id;
  const statuses = workspace.projectStatuses;
  const stages = pipeline.stages;

  // Inserted in bounded chunks: one createMany of 500k rows exhausts the
  // parameter limit on every engine this app targets.
  const chunk = async <T>(total: number, size: number, build: (i: number) => T,
                          write: (rows: T[]) => Promise<unknown>) => {
    for (let start = 0; start < total; start += size) {
      const rows = Array.from({ length: Math.min(size, total - start) }, (_, k) => build(start + k));
      await write(rows);
    }
  };

  await chunk(tier.companies, 2_000, (i) => ({
    id: `pf-co-${i}`, workspaceId: ws, name: `Company ${i}`,
    domain: `company${i}.example.com`, ownerId: user.id,
    industry: ["Education", "Nonprofit", "Government", "Tech"][i % 4],
    lastActivityAt: daysAgo(rand(120)),
  }), (rows) => db.company.createMany({ data: rows }));

  await chunk(tier.contacts, 2_000, (i) => ({
    id: `pf-ct-${i}`, workspaceId: ws,
    firstName: `Person${i}`, lastName: `Last${i % 500}`,
    fullName: `Person${i} Last${i % 500}`,
    email: `person${i}@company${i % tier.companies}.example.com`,
    companyId: `pf-co-${i % tier.companies}`, ownerId: user.id,
    lastContactedAt: daysAgo(rand(200)),
    nextFollowUpAt: i % 12 === 0 ? daysAgo(-rand(30)) : null,
  }), (rows) => db.contact.createMany({ data: rows }));

  await chunk(tier.projects, 1_000, (i) => ({
    id: `pf-pr-${i}`, workspaceId: ws, name: `Project ${i}`,
    companyId: `pf-co-${i % tier.companies}`,
    statusId: statuses[i % statuses.length]!.id, ownerId: user.id,
    lastActivityAt: daysAgo(rand(90)),
  }), (rows) => db.project.createMany({ data: rows }));

  await chunk(tier.deals, 2_000, (i) => ({
    id: `pf-dl-${i}`, workspaceId: ws, name: `Deal ${i}`,
    pipelineId: pipeline.id, stageId: stages[i % stages.length]!.id,
    valueCents: (1_000 + rand(200_000)) * 100,
    companyId: `pf-co-${i % tier.companies}`,
    primaryContactId: `pf-ct-${i % tier.contacts}`,
    projectId: i % 4 === 0 ? `pf-pr-${i % tier.projects}` : null,
    ownerId: user.id,
    stageEnteredAt: daysAgo(rand(120)), lastActivityAt: daysAgo(rand(60)),
    expectedCloseAt: daysAgo(-rand(120)),
    closedAt: i % 6 === 4 || i % 6 === 5 ? daysAgo(rand(90)) : null,
  }), (rows) => db.deal.createMany({ data: rows }));

  await chunk(tier.tasks, 2_000, (i) => ({
    id: `pf-tk-${i}`, workspaceId: ws, title: `Task ${i}`, ownerId: user.id,
    status: i % 3 === 0 ? "done" : "open",
    dueAt: daysAgo(rand(60) - 30),
    contactId: `pf-ct-${i % tier.contacts}`,
    dealId: i % 2 === 0 ? `pf-dl-${i % tier.deals}` : null,
    projectId: i % 5 === 0 ? `pf-pr-${i % tier.projects}` : null,
  }), (rows) => db.task.createMany({ data: rows }));

  await chunk(tier.activities, 5_000, (i) => ({
    id: `pf-ac-${i}`, workspaceId: ws,
    type: ["email", "call", "meeting", "note"][i % 4]!,
    title: `Activity ${i}`, actorId: user.id,
    direction: i % 3 === 0 ? "inbound" : "outbound",
    occurredAt: daysAgo(rand(180)),
    contactId: `pf-ct-${i % tier.contacts}`,
    companyId: `pf-co-${i % tier.companies}`,
    dealId: i % 2 === 0 ? `pf-dl-${i % tier.deals}` : null,
    projectId: i % 5 === 0 ? `pf-pr-${i % tier.projects}` : null,
  }), (rows) => db.activity.createMany({ data: rows }));

  return { workspaceId: ws, userId: user.id };
}

async function main() {
  console.log(
    `Seeding the "${tier.name}" tier: ${tier.contacts.toLocaleString()} contacts, ` +
      `${tier.deals.toLocaleString()} deals, ${tier.activities.toLocaleString()} activities…`,
  );
  const seedStart = performance.now();
  const { workspaceId } = await seed();
  console.log(`Seeded in ${((performance.now() - seedStart) / 1000).toFixed(1)}s\n`);

  const ids = [workspaceId];
  const scope = { workspaceIds: ids, workspaceNames: new Map([[workspaceId, "Perf"]]) };

  const results: { name: string; ms: number; budget: number; ok: boolean }[] = [];

  const measure = async (name: string, fn: () => Promise<unknown>) => {
    await fn(); // warm the query plan and any lazy connection
    const runs = 3;
    const start = performance.now();
    for (let i = 0; i < runs; i++) await fn();
    const ms = (performance.now() - start) / runs;
    const budget = (BUDGETS[name] ?? 500) * tier.budgetScale;
    results.push({ name, ms, budget, ok: ms <= budget });
  };

  await measure("Dashboard (home)", () => getDashboard(ids, null));
  await measure("Contacts list, page 1", () => listContacts(ids, { page: 1 }));
  await measure("Contacts list, deep page", () => listContacts(ids, { page: 100 }));
  await measure("Contacts search", () => listContacts(ids, { q: "Person12345" }));
  await measure("Contacts: needs follow-up", () => listContacts(ids, { view: "follow_up" }));
  await measure("Projects list", () => listProjects(ids, {}));
  await measure("Pipeline board", () => getPipelineBoard(ids, {}));
  await measure("Analytics (90 days)", () => getAnalytics(ids, 90));
  await measure("Analytics (1 year)", () => getAnalytics(ids, 365));
  await measure("Global search", () => searchEverything(ids, "Person999"));
  await measure("AI context snapshot", () => buildWorkspaceSnapshot(scope));
  await measure("AI cleanup scan", () => findRecommendations(scope));

  console.log(`Query timings, average of 3 warm runs — tier "${tier.name}":\n`);
  for (const r of results) {
    const status = r.ok ? "ok  " : "FAIL";
    console.log(
      `  ${status} ${r.name.padEnd(28)} ${r.ms.toFixed(0).padStart(6)} ms  ` +
        `(budget ${r.budget.toFixed(0)} ms)`,
    );
  }

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failures.length}/${results.length} within budget.` +
      (failures.length ? `  BREACHED: ${failures.map((f) => f.name).join(", ")}` : ""),
  );

  return failures.length;
}

main()
  .then((failures) => {
    process.exitCode = failures > 0 ? 1 : 0;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => db.$disconnect());
