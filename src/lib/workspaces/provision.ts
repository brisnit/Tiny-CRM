import "server-only";

import { randomUUID } from "node:crypto";

import { withTenantContext } from "@/lib/tenant-db";
import { slugify } from "@/lib/utils";
import {
  DEFAULT_DEAL_STAGES, DEFAULT_OPPORTUNITY_STAGES, DEFAULT_PROJECT_STATUSES,
} from "@/lib/enums";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Workspace provisioning.
 *
 * This module is `server-only` and deliberately carries NO `"use server"`
 * directive. Every export of a `"use server"` module becomes a callable HTTP
 * endpoint — which is exactly how the audit's most severe finding arose (F-01):
 * this function took a `userId` parameter and was reachable, unauthenticated,
 * from the internet. It is now only callable by server code that has already
 * authenticated the caller.
 */

export type ProvisionInput = {
  name: string;
  description?: string | null;
  color?: string;
};

/**
 * Creates a workspace with everything it needs to be usable immediately —
 * project statuses and both pipelines — in a single transaction, so a failure
 * part-way through cannot leave a workspace with no pipeline to put deals in.
 */

/**
 * A collision-resistant id generated before the row exists.
 *
 * Prisma's `@default(cuid())` runs at insert time, which is too late: the id has
 * to be in the tenant context *before* the INSERT is attempted. Shaped to
 * satisfy `zId` (alphanumeric, under 64 characters) and drawn from the CSPRNG.
 */
function newWorkspaceId(): string {
  return `c${randomUUID().replace(/-/g, "")}`;
}

export async function provisionWorkspace(
  userId: string,
  input: ProvisionInput,
  tx?: Prisma.TransactionClient,
): Promise<{ id: string; name: string; slug: string }> {
  // The workspace bootstrap problem.
  //
  // Every RLS policy answers "is this row's workspace one the caller may see?",
  // and the caller's set of visible workspaces comes from their memberships. A
  // workspace being created is in nobody's memberships yet, so the very first
  // INSERT — and the membership, pipelines and statuses created with it — is
  // denied by the policies that protect every other write.
  //
  // Rather than punch a hole in those policies, the id is generated here and
  // the whole provisioning runs inside a tenant context that contains it. The
  // rows are then created under exactly the same rule as every other write:
  // "this row belongs to a workspace in my context".
  //
  // The database does not have to trust that reasoning. A RESTRICTIVE policy in
  // prisma/postgres/004_workspace_bootstrap.sql independently requires
  // "ownerId" = app_user_id() for any Workspace INSERT, so even a caller who
  // could influence the context cannot create a workspace owned by someone
  // else. Restrictive policies AND with the permissive ones, so this narrows
  // the rule; it never widens it.
  const workspaceId = newWorkspaceId();

  const run = async (client: Prisma.TransactionClient) => {
    const name = input.name.trim().slice(0, 200);

    // Slugs are unique per owner; disambiguate rather than reject.
    const base = slugify(name) || "workspace";
    let slug = base;
    for (let i = 2; await client.workspace.findFirst({ where: { ownerId: userId, slug } }); i++) {
      slug = `${base}-${i}`;
      if (i > 50) {
        slug = `${base}-${Date.now().toString(36)}`;
        break;
      }
    }

    const workspace = await client.workspace.create({
      data: {
        id: workspaceId,
        name,
        slug,
        description: input.description?.slice(0, 1000) ?? null,
        color: input.color ?? "#068C28",
        ownerId: userId,
        members: { create: { userId, role: "owner" } },
        projectStatuses: {
          create: DEFAULT_PROJECT_STATUSES.map((status, i) => ({
            key: status.key,
            name: status.name,
            color: status.color,
            order: i,
            isTerminal: status.isTerminal,
            isDefault: "isDefault" in status ? Boolean(status.isDefault) : false,
          })),
        },
      },
      select: { id: true, name: true, slug: true },
    });

    await client.pipeline.create({
      data: {
        workspaceId: workspace.id,
        name: "Sales",
        kind: "deal",
        isDefault: true,
        order: 0,
        description: "The default pipeline for new business.",
        stages: {
          create: DEFAULT_DEAL_STAGES.map((stage, i) => ({
            name: stage.name, order: i, probability: stage.probability,
            color: stage.color, kind: stage.kind,
          })),
        },
      },
    });

    await client.pipeline.create({
      data: {
        workspaceId: workspace.id,
        name: "Opportunities",
        kind: "opportunity",
        isDefault: true,
        order: 1,
        description: "Formal solicitations, grants and partnership openings.",
        stages: {
          create: DEFAULT_OPPORTUNITY_STAGES.map((stage, i) => ({
            name: stage.name, order: i, probability: stage.probability,
            color: stage.color, kind: stage.kind,
          })),
        },
      },
    });

    return workspace;
  };

  // The context contains only the workspace being created. Provisioning touches
  // nothing else, and the caller's other workspaces stay out of reach for the
  // duration — a narrower context than the caller is entitled to, not a wider
  // one.
  return withTenantContext(
    { workspaceIds: [workspaceId], userId },
    (client) => (tx ? run(tx) : run(client)),
    { timeout: 15_000 },
  );
}
