import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

/**
 * Test fixtures.
 *
 * Builds two completely separate tenants — Workspace A and Workspace B — with no
 * shared membership. Every isolation test then asks the same question: can a
 * member of A reach anything in B?
 */

// The fixtures' connection is deliberately separate from the application's.
//
// The application under test connects as the restricted `tinycrm_app` role, so
// RLS is genuinely enforcing during the test. These fixtures are an out-of-band
// observer — they build the world before the test and check ground truth after
// it — and an observer bound by the same policies cannot see whether an attack
// was actually refused: a blocked read and an unchanged row look identical.
//
// So when FIXTURE_DATABASE_URL is provided the harness uses it (an owner
// connection), and the app still uses DATABASE_URL. With only DATABASE_URL set,
// both are the same connection and behaviour is unchanged from before.
const url = process.env.FIXTURE_DATABASE_URL ?? process.env.DATABASE_URL ?? "file:./test.db";

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


/**
 * Establishes tenant context on the fixtures' own client.
 *
 * These fixtures deliberately construct their own PrismaClient (mirroring
 * src/lib/db.ts) so a test helper never depends on the application's module
 * graph. That also means the application's AsyncLocalStorage-backed context
 * does not reach it, so bootstrap writes need their context set here.
 *
 * Same mechanism as production: `set_config(..., true)` is SET LOCAL, discarded
 * when the transaction ends, so nothing leaks onto a pooled connection.
 */
async function withFixtureContext<T>(
  workspaceIds: string[],
  userId: string,
  fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (url.startsWith("postgres")) {
      await tx.$executeRaw`SELECT set_config('app.workspace_ids', ${workspaceIds.join(",")}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    }
    return fn(tx);
  }, { timeout: 30_000 });
}

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

  // A tenant is bootstrapped exactly the way production bootstraps one: the id
  // is generated first and everything below runs inside a tenant context that
  // contains it, so RLS permits the writes for the same reason it permits them
  // at sign-up. Previously these were raw inserts, which worked only because no
  // test had ever run as the restricted role.
  const workspaceId = `c${randomUUID().replace(/-/g, "")}`;

  return withFixtureContext([workspaceId], owner.id, async (db) => {
  const workspace = await db.workspace.create({
    data: {
      id: workspaceId,
      name: `${label} Workspace`,
      slug: unique(label.toLowerCase()),
      ownerId: owner.id,
      // Only the owner's membership is created with the workspace. The others
      // are added immediately below, from a context in which the owner is
      // already a member — which is how an invitation actually happens, and
      // what prisma/postgres/004_workspace_bootstrap.sql requires.
      members: { create: [{ userId: owner.id, role: "owner" }] },
      projectStatuses: {
        create: [
          { key: "active", name: "Active", order: 0, isDefault: true },
          { key: "done", name: "Done", order: 1, isTerminal: true },
        ],
      },
    },
    include: { projectStatuses: true },
  });

  await db.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: member.id, role: "member" },
      { workspaceId: workspace.id, userId: viewer.id, role: "viewer" },
      // Given a high-privilege role on purpose: the gate must stop them
      // regardless of role, and a viewer could not export anyway.
      { workspaceId: workspace.id, userId: unverified.id, role: "admin" },
    ],
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
  });
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
