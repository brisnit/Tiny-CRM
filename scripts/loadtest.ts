/**
 * Scale probe.
 *
 * The brief asks whether the architecture can carry thousands of contacts and
 * hundreds of projects. This answers that by measurement rather than assertion:
 * it inflates a scratch workspace, then times the queries that actually back the
 * app's screens. Run with: npx tsx scripts/loadtest.ts
 */
import { db } from "../prisma/seed/helpers";
import { getDashboard } from "../src/lib/data/dashboard";
import { listContacts } from "../src/lib/data/contacts";
import { listProjects } from "../src/lib/data/projects";
import { getPipelineBoard } from "../src/lib/data/deals";
import { getAnalytics } from "../src/lib/data/analytics";
import { searchEverything } from "../src/lib/data/search";
import { findRecommendations } from "../src/lib/ai/recommendations";
import { buildWorkspaceSnapshot } from "../src/lib/ai/context";

const CONTACTS = Number(process.env.N_CONTACTS ?? 5000);
const COMPANIES = Number(process.env.N_COMPANIES ?? 800);
const PROJECTS = Number(process.env.N_PROJECTS ?? 400);
const DEALS = Number(process.env.N_DEALS ?? 3000);
const TASKS = Number(process.env.N_TASKS ?? 6000);
const ACTIVITIES = Number(process.env.N_ACTIVITIES ?? 20000);

const rand = (n: number) => Math.floor(Math.random() * n);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function main() {
  const user = await db.user.findFirstOrThrow({ where: { email: "owner@tinycrm.app" } });

  let ws = await db.workspace.findFirst({ where: { slug: "scale-test", ownerId: user.id } });
  if (ws) {
    console.log("Removing previous scale-test workspace…");
    await db.workspace.delete({ where: { id: ws.id } });
  }

  console.log(`Building a scale-test workspace: ${CONTACTS} contacts, ${COMPANIES} companies, ${PROJECTS} projects, ${DEALS} deals, ${TASKS} tasks, ${ACTIVITIES} activities…`);
  const t0 = Date.now();

  ws = await db.workspace.create({
    data: {
      name: "Scale Test", slug: "scale-test", ownerId: user.id,
      members: { create: { userId: user.id, role: "owner" } },
      projectStatuses: {
        create: ["Idea", "Active", "Waiting", "Completed"].map((name, i) => ({
          key: name.toLowerCase(), name, order: i, isTerminal: name === "Completed",
          isDefault: name === "Active",
        })),
      },
    },
  });

  const pipeline = await db.pipeline.create({
    data: {
      workspaceId: ws.id, name: "Sales", kind: "deal", isDefault: true,
      stages: {
        create: ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"].map((name, i) => ({
          name, order: i, probability: i * 20,
          kind: name === "Won" ? "won" : name === "Lost" ? "lost" : "open",
        })),
      },
    },
    include: { stages: true },
  });
  const statuses = await db.projectStatus.findMany({ where: { workspaceId: ws.id } });

  const chunk = async <T>(items: T[], size: number, fn: (batch: T[]) => Promise<unknown>) => {
    for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
  };

  const companyIds: string[] = [];
  await chunk([...Array(COMPANIES).keys()], 200, async (batch) => {
    await db.company.createMany({
      data: batch.map((i) => ({
        id: `sc-co-${i}`, workspaceId: ws!.id, name: `Scale Company ${i}`,
        domain: `company${i}.example.com`, industry: ["Education", "Healthcare", "Retail", "Nonprofit"][i % 4],
        ownerId: user.id, lastActivityAt: daysAgo(rand(120)),
      })),
    });
    batch.forEach((i) => companyIds.push(`sc-co-${i}`));
  });

  await chunk([...Array(CONTACTS).keys()], 500, async (batch) => {
    await db.contact.createMany({
      data: batch.map((i) => ({
        id: `sc-ct-${i}`, workspaceId: ws!.id,
        firstName: `Person${i}`, lastName: `Sample${i % 500}`, fullName: `Person${i} Sample${i % 500}`,
        email: `person${i}@company${i % COMPANIES}.example.com`,
        companyId: `sc-co-${i % COMPANIES}`, ownerId: user.id,
        relationshipType: ["client", "prospect", "partner"][i % 3],
        lastContactedAt: i % 7 === 0 ? null : daysAgo(rand(180)),
        nextFollowUpAt: i % 11 === 0 ? daysAgo(rand(30)) : null,
        createdAt: daysAgo(rand(400) + 30),
      })),
    });
  });

  await chunk([...Array(PROJECTS).keys()], 200, async (batch) => {
    await db.project.createMany({
      data: batch.map((i) => ({
        id: `sc-pr-${i}`, workspaceId: ws!.id, name: `Scale Project ${i}`,
        companyId: `sc-co-${i % COMPANIES}`, statusId: statuses[i % statuses.length]!.id,
        ownerId: user.id, targetDate: daysAgo(-rand(120) + 30),
        lastActivityAt: daysAgo(rand(60)), budgetCents: rand(500) * 10000,
        revenueCents: rand(400) * 10000, nextAction: i % 3 === 0 ? `Next action for project ${i}` : null,
      })),
    });
  });

  const openStages = pipeline.stages.filter((s) => s.kind === "open");
  await chunk([...Array(DEALS).keys()], 400, async (batch) => {
    await db.deal.createMany({
      data: batch.map((i) => {
        const stage = i % 9 === 0 ? pipeline.stages[4]! : openStages[i % openStages.length]!;
        return {
          id: `sc-dl-${i}`, workspaceId: ws!.id, name: `Scale Deal ${i}`,
          companyId: `sc-co-${i % COMPANIES}`, primaryContactId: `sc-ct-${i % CONTACTS}`,
          projectId: i % 4 === 0 ? `sc-pr-${i % PROJECTS}` : null,
          pipelineId: pipeline.id, stageId: stage.id,
          valueCents: (rand(200) + 5) * 100000, ownerId: user.id,
          expectedCloseAt: daysAgo(-rand(120) + 20),
          stageEnteredAt: daysAgo(rand(90)), lastActivityAt: daysAgo(rand(60)),
          closedAt: stage.kind === "won" ? daysAgo(rand(90)) : null,
          createdAt: daysAgo(rand(300) + 30),
          source: ["referral", "inbound", "outbound", "event"][i % 4],
        };
      }),
    });
  });

  await chunk([...Array(TASKS).keys()], 500, async (batch) => {
    await db.task.createMany({
      data: batch.map((i) => ({
        id: `sc-tk-${i}`, workspaceId: ws!.id, title: `Scale Task ${i}`, ownerId: user.id,
        status: i % 3 === 0 ? "done" : "open",
        dueAt: i % 5 === 0 ? null : daysAgo(rand(60) - 30),
        completedAt: i % 3 === 0 ? daysAgo(rand(60)) : null,
        priority: ["low", "medium", "high", "urgent"][i % 4],
        projectId: i % 2 === 0 ? `sc-pr-${i % PROJECTS}` : null,
        dealId: i % 3 === 1 ? `sc-dl-${i % DEALS}` : null,
        contactId: i % 4 === 2 ? `sc-ct-${i % CONTACTS}` : null,
      })),
    });
  });

  await chunk([...Array(ACTIVITIES).keys()], 1000, async (batch) => {
    await db.activity.createMany({
      data: batch.map((i) => ({
        id: `sc-ac-${i}`, workspaceId: ws!.id,
        type: ["email", "call", "meeting", "note"][i % 4],
        title: `Scale activity ${i}`, actorId: user.id,
        direction: i % 3 === 0 ? "inbound" : "outbound",
        occurredAt: daysAgo(rand(180)),
        contactId: `sc-ct-${i % CONTACTS}`,
        companyId: `sc-co-${i % COMPANIES}`,
        dealId: i % 2 === 0 ? `sc-dl-${i % DEALS}` : null,
        projectId: i % 5 === 0 ? `sc-pr-${i % PROJECTS}` : null,
      })),
    });
  });

  console.log(`Built in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const ids = [ws.id];
  const scope = { workspaceIds: ids, workspaceNames: new Map([[ws.id, "Scale Test"]]) };

  const time = async (name: string, fn: () => Promise<unknown>) => {
    await fn(); // warm
    const runs = 3;
    const start = Date.now();
    for (let i = 0; i < runs; i++) await fn();
    const ms = (Date.now() - start) / runs;
    const flag = ms > 500 ? "  ← SLOW" : ms > 200 ? "  ← watch" : "";
    console.log(`${name.padEnd(42)} ${ms.toFixed(0).padStart(6)} ms${flag}`);
    return ms;
  };

  console.log("Query timings (average of 3 runs, warm):\n");
  await time("Dashboard (home page)", () => getDashboard(ids, null));
  await time("Contacts list, page 1 + scores", () => listContacts(ids, { page: 1 }));
  await time("Contacts list, page 50", () => listContacts(ids, { page: 50 }));
  await time("Contacts search 'Person123'", () => listContacts(ids, { q: "Person123" }));
  await time("Contacts: needs follow-up view", () => listContacts(ids, { view: "follow_up" }));
  await time("Projects list", () => listProjects(ids, {}));
  await time("Pipeline board", () => getPipelineBoard(ids, {}));
  await time("Analytics (90 days)", () => getAnalytics(ids, 90));
  await time("Analytics (1 year)", () => getAnalytics(ids, 365));
  await time("Global search 'Scale'", () => searchEverything(ids, "Scale"));
  await time("AI context snapshot", () => buildWorkspaceSnapshot(scope));
  await time("AI cleanup scan", () => findRecommendations(scope));

  const counts = {
    contacts: await db.contact.count({ where: { workspaceId: ws.id } }),
    deals: await db.deal.count({ where: { workspaceId: ws.id } }),
    activities: await db.activity.count({ where: { workspaceId: ws.id } }),
  };
  console.log("\nWorkspace contains:", counts);
  console.log("\nRemove with: npx tsx scripts/loadtest.ts --clean");
}

async function clean() {
  const ws = await db.workspace.findFirst({ where: { slug: "scale-test" } });
  if (ws) {
    await db.workspace.delete({ where: { id: ws.id } });
    console.log("Scale-test workspace removed.");
  } else console.log("Nothing to clean.");
}

(process.argv.includes("--clean") ? clean() : main())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
