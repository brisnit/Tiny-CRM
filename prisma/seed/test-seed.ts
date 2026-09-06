import { assertSafeToSeed } from "./guard";

import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

/**
 * A seed built for verification, not for a demo.
 *
 * The demo seed (`prisma/seed/index.ts`) exists to make the product look real:
 * it wipes the database and creates accounts with a password published in the
 * README. This one exists to give a verification run something with shape —
 * two fully separated tenants, every entity type, referential edges in both
 * directions — without any of that:
 *
 *  - **No published passwords.** Each run generates random ones and prints only
 *    the emails. Nothing here is a usable credential after the process exits.
 *  - **Deterministic content, unique identities.** Record names are fixed so
 *    assertions can rely on them; emails and slugs carry a run suffix so a
 *    second run does not collide with the first.
 *  - **Additive.** It does not delete anything, so it can be pointed at a
 *    database that already has data.
 *
 * It refuses a real database through the same guard the demo seed uses.
 *
 *   DATABASE_URL=… npx tsx prisma/seed/test-seed.ts
 */

assertSafeToSeed("verification");

const url = process.env.DATABASE_URL ?? "file:./dev.db";
const isPostgres = /^postgres(ql)?:\/\//.test(url);

const db = new PrismaClient({
  adapter: isPostgres
    ? new PrismaPg({ connectionString: url })
    : new PrismaBetterSqlite3({ url }),
});

const RUN = process.env.SEED_SUFFIX ?? Date.now().toString(36);
const password = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;

async function tenant(label: string) {
  const hash = await bcrypt.hash(password(), 10);
  const slug = `${label.toLowerCase()}-${RUN}`;

  const [owner, member, viewer] = await Promise.all(
    ["owner", "member", "viewer"].map((role) =>
      db.user.create({
        data: {
          email: `${label.toLowerCase()}-${role}-${RUN}@verify.local`,
          name: `${label} ${role[0]!.toUpperCase()}${role.slice(1)}`,
          passwordHash: hash,
          emailVerifiedAt: new Date(),
        },
      }),
    ),
  );

  const workspace = await db.workspace.create({
    data: {
      name: `${label} Workspace`,
      slug,
      ownerId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
          { userId: viewer.id, role: "viewer" },
        ],
      },
      projectStatuses: {
        create: [
          { key: "idea", name: "Idea", order: 0 },
          { key: "active", name: "Active", order: 1, isDefault: true },
          { key: "done", name: "Done", order: 2, isTerminal: true },
        ],
      },
    },
    include: { projectStatuses: true },
  });

  const pipeline = await db.pipeline.create({
    data: {
      workspaceId: workspace.id,
      name: "Sales",
      kind: "deal",
      isDefault: true,
      stages: {
        create: [
          { name: "New", order: 0, probability: 10, kind: "open" },
          { name: "Proposal", order: 1, probability: 60, kind: "open" },
          { name: "Won", order: 2, probability: 100, kind: "won" },
          { name: "Lost", order: 3, probability: 0, kind: "lost" },
        ],
      },
    },
    include: { stages: { orderBy: { order: "asc" } } },
  });

  const company = await db.company.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Holdings`,
      domain: `${label.toLowerCase()}-${RUN}.example.com`,
      industry: "Education",
      relationshipStatus: "client",
      ownerId: owner.id,
    },
  });

  const contact = await db.contact.create({
    data: {
      workspaceId: workspace.id,
      firstName: label,
      lastName: "Contact",
      fullName: `${label} Contact`,
      email: `${label.toLowerCase()}-contact-${RUN}@verify.local`,
      jobTitle: "Director of Operations",
      companyId: company.id,
      ownerId: owner.id,
      lastContactedAt: new Date(),
    },
  });

  await db.company.update({
    where: { id: company.id },
    data: { primaryContactId: contact.id },
  });

  const project = await db.project.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Platform Rollout`,
      companyId: company.id,
      statusId: workspace.projectStatuses.find((s) => s.isDefault)!.id,
      ownerId: owner.id,
      budgetCents: 250_000_00,
      lastActivityAt: new Date(),
    },
  });

  const deal = await db.deal.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Annual Renewal`,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[1]!.id,
      valueCents: 120_000_00,
      companyId: company.id,
      primaryContactId: contact.id,
      projectId: project.id,
      ownerId: owner.id,
      stageEnteredAt: new Date(),
      lastActivityAt: new Date(),
    },
  });

  const opportunity = await db.opportunity.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} RFP_2026_014`,
      companyId: company.id,
      ownerId: owner.id,
      type: "rfp",
      solicitationNumber: "RFP_2026_014",
      submissionStatus: "in_progress",
      estimatedValueCents: 500_000_00,
    },
  });

  const task = await db.task.create({
    data: {
      workspaceId: workspace.id,
      title: `Follow up with ${label} Contact`,
      ownerId: owner.id,
      dealId: deal.id,
      contactId: contact.id,
      dueAt: new Date(Date.now() + 3 * 86_400_000),
    },
  });

  const note = await db.note.create({
    data: {
      workspaceId: workspace.id,
      title: `${label} internal assessment`,
      body: "<p>Confidential commercial detail.</p>",
      plainText: "Confidential commercial detail.",
      authorId: owner.id,
      contactId: contact.id,
      companyId: company.id,
    },
  });

  await db.activity.createMany({
    data: [
      {
        workspaceId: workspace.id, type: "call", title: `Kickoff call with ${label}`,
        actorId: owner.id, contactId: contact.id, companyId: company.id, dealId: deal.id,
        occurredAt: new Date(Date.now() - 86_400_000),
      },
      {
        workspaceId: workspace.id, type: "email", title: `Proposal sent to ${label}`,
        actorId: owner.id, companyId: company.id, dealId: deal.id, direction: "outbound",
        occurredAt: new Date(Date.now() - 3_600_000),
      },
    ],
  });

  const tag = await db.tag.create({
    data: { workspaceId: workspace.id, name: "verification" },
  });
  await db.tagLink.create({
    data: { workspaceId: workspace.id, tagId: tag.id, entityType: "contact", entityId: contact.id },
  });

  await db.automation.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} won-deal follow-up`,
      trigger: "deal_stage_changed",
      enabled: true,
      conditions: JSON.stringify([{ field: "stageKind", op: "equals", value: "won" }]),
      actions: JSON.stringify([{ type: "create_task", title: "Send the welcome pack" }]),
    },
  });

  return {
    label,
    workspaceId: workspace.id,
    ownerEmail: owner.email,
    ids: {
      owner: owner.id, member: member.id, viewer: viewer.id,
      company: company.id, contact: contact.id, project: project.id,
      deal: deal.id, opportunity: opportunity.id, task: task.id, note: note.id,
    },
  };
}

async function main() {
  console.log(`Seeding verification data (${isPostgres ? "PostgreSQL" : "SQLite"}, run ${RUN})…`);

  const alpha = await tenant("Verify");
  const bravo = await tenant("Isolate");

  const counts = {
    workspaces: await db.workspace.count(),
    users: await db.user.count(),
    companies: await db.company.count(),
    contacts: await db.contact.count(),
    projects: await db.project.count(),
    deals: await db.deal.count(),
    opportunities: await db.opportunity.count(),
    tasks: await db.task.count(),
    notes: await db.note.count(),
    activities: await db.activity.count(),
  };

  console.log("\nTwo isolated tenants created:");
  console.log(`  ${alpha.label}: workspace ${alpha.workspaceId}  owner ${alpha.ownerEmail}`);
  console.log(`  ${bravo.label}: workspace ${bravo.workspaceId}  owner ${bravo.ownerEmail}`);
  console.log("\nTotals:", counts);
  console.log(
    "\nPasswords are random per run and are not printed. Use runAsTestIdentity()\n" +
      "or reset one deliberately if you need to sign in.\n",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
