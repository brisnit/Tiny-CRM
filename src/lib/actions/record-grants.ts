"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit, guard, readWorkspaceId, revalidateRecord, workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { AppError } from "@/lib/errors";
import { zId } from "@/lib/validation/common";
import { assertUnrestrictedActor } from "@/lib/auth/access";
import { resolveAnchors } from "@/lib/auth/anchors";

/**
 * Giving and taking away access to one piece of work.
 *
 * A grant names an anchor — an Opportunity or a Project — and the person who
 * may reach it. Everything hanging off that anchor follows; nothing else does.
 * The enforcement is in the database (prisma/postgres/010_record_scope.sql);
 * this is the surface through which a grant is created and destroyed, and the
 * record of who did it.
 *
 * Granting access is access control, not record editing, so it requires
 * `members:manage` — Owner and Admin. A manager can run the work without
 * deciding who else may see it.
 *
 * These are the incremental verbs — add one record, remove one record. Setting
 * somebody's whole grant set at once, and moving them between scopes, is
 * `setMemberScope` in settings.ts. Keeping them apart is deliberate: "give them
 * this too" and "their access is now exactly this" are different intentions,
 * and a single call that guesses which one you meant would eventually guess
 * wrong.
 *
 * Both refuse a restricted caller, and both refuse a target who is not
 * restricted — a grant that changes nothing is not a grant, it is a row waiting
 * to mean something later.
 */

const ANCHORS = ["opportunity", "project"] as const;

const grantSchema = z.object({
  workspaceId: zId,
  userId: zId,
  anchorType: z.enum(ANCHORS),
  anchorId: zId,
});

type GrantInput = z.input<typeof grantSchema>;

export async function grantRecordAccess(
  input: GrantInput,
): Promise<ActionResult<{ id: string; anchorType: string; anchorId: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = grantSchema.parse(input);
        const workspaceId = actor.workspaceId;
        assertUnrestrictedActor(actor, workspaceId);

        // The recipient must be someone here, and must actually be restricted.
        // A grant to a full-workspace member changes nothing they can reach; it
        // is a row that means "no" while looking like "yes", and it is exactly
        // the dormant state that made grants outlive the access they described.
        const membership = await db.workspaceMember.findFirst({
          where: { workspaceId, userId: data.userId },
          select: { id: true, scopeMode: true },
        });
        if (!membership) throw new AppError("not_found", "That person is not in this workspace.");
        if (membership.scopeMode !== "restricted") {
          throw new AppError(
            "validation",
            "That person already has access to the whole workspace. " +
              "Change their access to limited first.",
          );
        }

        // The anchor is read through the caller's own context, so an anchor
        // they cannot see is indistinguishable from one that does not exist —
        // and cannot be granted to anybody. Archived anchors are refused: the
        // record is in the trash, and access to it is access to something
        // somebody decided was over.
        const resolved = await resolveAnchors(db, workspaceId, [
          { entityType: data.anchorType, entityId: data.anchorId },
        ]);
        if (!resolved.ok) throw new AppError("not_found", "That record no longer exists.");

        const anchor =
          data.anchorType === "opportunity"
            ? await db.opportunity.findFirst({ where: { id: data.anchorId, workspaceId }, select: { name: true } })
            : await db.project.findFirst({ where: { id: data.anchorId, workspaceId }, select: { name: true } });
        if (!anchor) throw new AppError("not_found", "That record no longer exists.");

        const grant = await db.recordGrant.upsert({
          where: {
            workspaceId_userId_anchorType_anchorId: {
              workspaceId,
              userId: data.userId,
              anchorType: data.anchorType,
              anchorId: data.anchorId,
            },
          },
          create: {
            workspaceId,
            userId: data.userId,
            // The membership, not just the person. Deleting it takes this row
            // with it, and the composite foreign key refuses a row whose three
            // identity columns do not describe the same membership.
            membershipId: membership.id,
            anchorType: data.anchorType,
            anchorId: data.anchorId,
            grantedById: actor.identity.id,
          },
          update: {},
          select: { id: true },
        });

        await audit(actor, {
          workspaceId,
          action: "member.access_granted",
          entityType: data.anchorType,
          entityId: data.anchorId,
          summary: `Gave access to ${anchor.name}`,
          metadata: { userId: data.userId, anchorType: data.anchorType, anchorId: data.anchorId },
        });

        revalidateRecord(["/settings/team"]);
        return { id: grant.id, anchorType: data.anchorType, anchorId: data.anchorId };
      },
    ),
  );
}

export async function revokeRecordAccess(
  input: GrantInput,
): Promise<ActionResult<{ revoked: number }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = grantSchema.parse(input);
        const workspaceId = actor.workspaceId;
        assertUnrestrictedActor(actor, workspaceId);

        // Deleting the row is the revocation: the policies read this table on
        // every statement, so access ends at the next one rather than at the
        // recipient's next sign-in.
        const result = await db.recordGrant.deleteMany({
          where: {
            workspaceId,
            userId: data.userId,
            anchorType: data.anchorType,
            anchorId: data.anchorId,
          },
        });

        // Audited even when nothing matched. "I revoked it and nothing
        // happened" is worth being able to reconstruct later.
        await audit(actor, {
          workspaceId,
          action: "member.access_revoked",
          entityType: data.anchorType,
          entityId: data.anchorId,
          summary: result.count > 0 ? "Removed access to a record" : "Removed access that was not held",
          metadata: {
            userId: data.userId,
            anchorType: data.anchorType,
            anchorId: data.anchorId,
            removed: result.count,
          },
        });

        revalidateRecord(["/settings/team"]);
        return { revoked: result.count };
      },
    ),
  );
}
