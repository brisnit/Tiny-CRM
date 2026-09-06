import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

/**
 * Test fixtures.
 *
 * Builds two completely separate tenants — Workspace A and Workspace B — with no
 * shared membership. Every isolation test then asks the same question: can a
 * member of A reach anything in B?
 */

const url = process.env.DATABASE_URL ?? "file:./test.db";

// The adapter is chosen from the connection string, exactly as src/lib/db.ts
// does, so the same suite runs unchanged against SQLite locally and PostgreSQL
// in CI. A test helper hard-wired to one engine would quietly make the
// portability job meaningless.
const isPostgres = /^postgres(ql)?:\/\//.test(url);

export const db = new PrismaClient({
  adapter: isPostgres
    ? new PrismaPg({ connectionString: url })
    : new PrismaBetterSqlite3({ url }),
});

export type Tenant = {
  workspaceId: string;
  ownerId: string;
  memberId: string;
  viewerId: string;
  /** A member whose email address has never been confirmed. */
  unverifiedId: string;
  contactId: string;
  companyId: string;
  dealId: string;
  projectId: string;
  opportunityId: string;
  taskId: string;
  noteId: string;
  activityId: string;
  pipelineId: string;
  stageId: string;
  otherStageId: string;
  statusId: string;
  automationId: string;
  tagId: string;
};

let counter = 0;
const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

export async function createTenant(label: string): Promise<Tenant> {
  const password = await bcrypt.hash("correct-horse-battery", 4);

  // Verified by default: an unverified account cannot export, invite or connect
  // an integration, so leaving these unverified would make most tests assert the
  // verification gate rather than the thing they are named for.
  const verified = new Date();

  const owner = await db.user.create({
    data: {
      email: `${unique(`${label}-owner`)}@test.local`, name: `${label} Owner`,
      passwordHash: password, emailVerifiedAt: verified,
    },
  });
  const member = await db.user.create({
    data: {
      email: `${unique(`${label}-member`)}@test.local`, name: `${label} Member`,
      passwordHash: password, emailVerifiedAt: verified,
    },
  });
  const viewer = await db.user.create({
    data: {
      email: `${unique(`${label}-viewer`)}@test.local`, name: `${label} Viewer`,
      passwordHash: password, emailVerifiedAt: verified,
    },
  });
  // Deliberately unverified, so the gate itself can be tested.
  const unverified = await db.user.create({
    data: {
      email: `${unique(`${label}-unverified`)}@test.local`, name: `${label} Unverified`,
      passwordHash: password,
    },
  });

  const workspace = await db.workspace.create({
    data: {
      name: `${label} Workspace`,
      slug: unique(label.toLowerCase()),
      ownerId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
          { userId: viewer.id, role: "viewer" },
          // Given a high-privilege role on purpose: the gate must stop them
          // regardless of role, and a viewer could not export anyway.
          { userId: unverified.id, role: "admin" },
        ],
      },
      projectStatuses: {
        create: [
          { key: "active", name: "Active", order: 0, isDefault: true },
          { key: "done", name: "Done", order: 1, isTerminal: true },
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
          { name: "Won", order: 1, probability: 100, kind: "won" },
        ],
      },
    },
    include: { stages: { orderBy: { order: "asc" } } },
  });

  const company = await db.company.create({
    data: { workspaceId: workspace.id, name: `${label} Secret Corp`, ownerId: owner.id, domain: `${label.toLowerCase()}.example.com` },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId: workspace.id,
      firstName: label, lastName: "Confidential",
      fullName: `${label} Confidential`,
      email: `${unique(`${label}-contact`)}@client.example.com`,
      companyId: company.id, ownerId: owner.id,
    },
  });
  const project = await db.project.create({
    data: {
      workspaceId: workspace.id, name: `${label} Secret Project`,
      companyId: company.id, statusId: workspace.projectStatuses[0]!.id, ownerId: owner.id,
    },
  });
  const deal = await db.deal.create({
    data: {
      workspaceId: workspace.id, name: `${label} Confidential Deal`,
      pipelineId: pipeline.id, stageId: pipeline.stages[0]!.id,
      valueCents: 5_000_00, companyId: company.id, primaryContactId: contact.id, ownerId: owner.id,
    },
  });
  const opportunity = await db.opportunity.create({
    data: { workspaceId: workspace.id, name: `${label} Secret RFP`, companyId: company.id, ownerId: owner.id },
  });
  const task = await db.task.create({
    data: { workspaceId: workspace.id, title: `${label} private task`, ownerId: owner.id, dealId: deal.id },
  });
  const note = await db.note.create({
    data: {
      workspaceId: workspace.id, title: `${label} private note`,
      body: "<p>confidential</p>", plainText: "confidential",
      authorId: owner.id, contactId: contact.id,
    },
  });
  const activity = await db.activity.create({
    data: { workspaceId: workspace.id, type: "note", title: `${label} private activity`, actorId: owner.id, dealId: deal.id },
  });
  const automation = await db.automation.create({
    data: { workspaceId: workspace.id, name: `${label} rule`, trigger: "deal_stage_changed" },
  });
  const tag = await db.tag.create({
    data: { workspaceId: workspace.id, name: `${label}-tag` },
  });

  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    memberId: member.id,
    viewerId: viewer.id,
    unverifiedId: unverified.id,
    contactId: contact.id,
    companyId: company.id,
    dealId: deal.id,
    projectId: project.id,
    opportunityId: opportunity.id,
    taskId: task.id,
    noteId: note.id,
    activityId: activity.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0]!.id,
    otherStageId: pipeline.stages[1]!.id,
    statusId: workspace.projectStatuses[0]!.id,
    automationId: automation.id,
    tagId: tag.id,
  };
}

export async function cleanupTenants(tenants: Tenant[]) {
  for (const tenant of tenants) {
    await db.workspace.deleteMany({ where: { id: tenant.workspaceId } });
    await db.user.deleteMany({
      where: {
        id: { in: [tenant.ownerId, tenant.memberId, tenant.viewerId, tenant.unverifiedId] },
      },
    });
  }
}

/** Asserts a server action refused, and reports the category it refused with. */
export function expectRefused(
  result: { ok: boolean; error?: string; category?: string },
  what: string,
): void {
  if (result.ok) {
    throw new Error(`SECURITY FAILURE: ${what} was ALLOWED but must be refused.`);
  }
}

export function expectAllowed(
  result: { ok: boolean; error?: string },
  what: string,
): void {
  if (!result.ok) {
    throw new Error(`Expected ${what} to succeed, but it failed: ${result.error}`);
  }
}
