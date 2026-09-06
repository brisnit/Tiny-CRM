"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  action, audit, guard, readWorkspaceId, recordAction, revalidateLayout,
  revalidatePathSafely, revalidateRecord, transaction, workspaceAction,
  type ActionResult,
} from "@/lib/actions/base";
import { assertCanAssignRole, requireRole } from "@/lib/auth/access";
import { ROLES } from "@/lib/auth/permissions";
import { assertWithinLimit } from "@/lib/entitlements";
import { assertConfirmation } from "@/lib/destructive";
import { emitEvent } from "@/lib/events";
import { raiseAlert } from "@/lib/security/alerts";
import { AppError } from "@/lib/errors";
import { provisionWorkspace } from "@/lib/workspaces/provision";
import { WORKSPACE_DELETION_GRACE_DAYS } from "@/lib/workspaces/policy";
import { LIMITS } from "@/lib/validation/limits";
import { zId, zOptionalText, zShortText } from "@/lib/validation/common";

/**
 * Settings and administration.
 *
 * Two things are deliberately *absent* from this file:
 *
 *  - **No `changePlan`.** The prototype let the browser assign its own plan,
 *    which lifted every entitlement limit for free (F-04). Plan state is now
 *    writable only by the verified billing webhook — see src/lib/billing.
 *  - **No `createWorkspaceWithDefaults(userId, …)`.** Taking a user id as a
 *    parameter in a `"use server"` module made it an unauthenticated endpoint
 *    that could provision a workspace for anyone (F-01). Provisioning now lives
 *    in a `server-only` module and always uses the session's own identity.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const zColor = z.string().trim().regex(HEX_COLOR, "Use a hex colour like #068C28");

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  name: zShortText.min(1, "What should we call you?").optional(),
  jobTitle: zOptionalText(LIMITS.shortText),
  timezone: zShortText.max(64).optional(),
});

/**
 * The schema lists exactly three fields. `plan`, `role`, `email` and
 * `passwordHash` are not among them, so a payload carrying them is stripped
 * rather than partially applied.
 */
export async function updateProfile(
  input: z.input<typeof profileSchema>,
): Promise<ActionResult<{ ok: true }>> {
  return guard(() =>
    action(
      async (actor) => {
        const data = profileSchema.parse(input);
        await db.user.update({
          where: { id: actor.identity.id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle } : {}),
            ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
          },
        });
        revalidateLayout();
        return { ok: true as const };
      },
      { rateLimit: "mutation" },
    ),
  );
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

const workspaceSchema = z.object({
  name: zShortText.min(1, "Give the workspace a name"),
  description: zOptionalText(LIMITS.mediumText),
  color: zColor.optional(),
});

const workspaceUpdateSchema = workspaceSchema.partial();

export async function createWorkspace(
  input: z.input<typeof workspaceSchema>,
): Promise<ActionResult<{ id: string; name: string }>> {
  return guard(() =>
    action(
      async (actor) => {
        const data = workspaceSchema.parse(input);
        await assertWithinLimit(actor, "workspaces");

        const workspace = await provisionWorkspace(actor.identity.id, data);

        await audit(actor, {
          workspaceId: workspace.id,
          action: "workspace.created",
          entityType: "workspace",
          entityId: workspace.id,
          summary: `Created workspace ${workspace.name}`,
        });

        revalidateLayout();
        return { id: workspace.id, name: workspace.name };
      },
      { rateLimit: "mutation" },
    ),
  );
}

export async function updateWorkspace(
  id: string,
  input: z.input<typeof workspaceUpdateSchema>,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: id, permission: "workspace:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = workspaceUpdateSchema.parse(input);

        await db.workspace.update({
          where: { id: actor.workspaceId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
          },
        });

        await audit(actor, {
          workspaceId: actor.workspaceId,
          action: "workspace.updated",
          entityType: "workspace",
          entityId: actor.workspaceId,
          summary: "Updated workspace settings",
          metadata: data,
        });

        revalidateLayout();
        return { id: actor.workspaceId };
      },
    ),
  );
}

/**
 * Schedules a workspace for deletion.
 *
 * The most destructive operation in the product: `Workspace` is the cascade
 * root, so every record it owns goes with it. It used to happen on the click.
 *
 * It no longer does. The request is recorded, an alert is raised, and a worker
 * performs the deletion after a grace period — during which any owner can
 * cancel it. An entire customer's business should not end because of one
 * mis-click, one stolen session, or one bad afternoon.
 *
 * Still requires `workspace:delete` (owner only) and the workspace name retyped,
 * verified here rather than in the dialog.
 */
export async function requestWorkspaceDeletion(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string; scheduledAt: Date }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: id, permission: "workspace:delete", rateLimit: "mutation" },
      async (actor) => {
        const workspace = await db.workspace.findUniqueOrThrow({
          where: { id: actor.workspaceId },
          select: { name: true, deletionScheduledAt: true },
        });
        assertConfirmation(confirmation, workspace.name);

        if (workspace.deletionScheduledAt) {
          throw new AppError(
            "conflict",
            "This workspace is already scheduled for deletion.",
          );
        }

        const scheduledAt = new Date(
          Date.now() + WORKSPACE_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
        );

        await transaction(async (tx) => {
          await tx.workspace.update({
            where: { id: actor.workspaceId },
            data: {
              deletionRequestedAt: new Date(),
              deletionRequestedById: actor.identity.id,
              deletionScheduledAt: scheduledAt,
            },
          });

          // The job the worker will pick up when the grace period ends. It
          // re-reads the schedule, so a cancellation makes it a no-op.
          await emitEvent(
            {
              workspaceId: actor.workspaceId,
              name: "workspace.deletion_due",
              entityType: "workspace",
              entityId: actor.workspaceId,
              actorId: actor.identity.id,
              payload: { scheduledAt: scheduledAt.toISOString() },
            },
            tx,
          );
          await tx.domainEvent.updateMany({
            where: {
              workspaceId: actor.workspaceId,
              name: "workspace.deletion_due",
              processedAt: null,
            },
            // Not eligible for a worker until the grace period is over.
            data: { availableAt: scheduledAt },
          });
        });

        await audit(actor, {
          workspaceId: actor.workspaceId,
          action: "workspace.deletion_requested",
          entityType: "workspace",
          entityId: actor.workspaceId,
          summary: `Scheduled deletion of workspace ${workspace.name}`,
          metadata: { scheduledAt: scheduledAt.toISOString() },
        });

        await raiseAlert({
          kind: "workspace.deletion_requested",
          workspaceId: actor.workspaceId,
          userId: actor.identity.id,
          summary:
            `Workspace "${workspace.name}" is scheduled for deletion on ` +
            `${scheduledAt.toISOString().slice(0, 10)}. Export first if this was not intended.`,
          dedupeKey: `workspace-deletion:${actor.workspaceId}`,
        });

        revalidateLayout();
        return { id: actor.workspaceId, scheduledAt };
      },
    ),
  );
}

/** Cancels a scheduled deletion, any time before the worker runs it. */
export async function cancelWorkspaceDeletion(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: id, permission: "workspace:delete", rateLimit: "mutation" },
      async (actor) => {
        await db.workspace.updateMany({
          where: { id: actor.workspaceId },
          data: {
            deletionRequestedAt: null,
            deletionRequestedById: null,
            deletionScheduledAt: null,
          },
        });

        // The scheduled job is left in place deliberately: it re-reads the
        // schedule and does nothing when there is none. Deleting it here would
        // be a second write that could fail independently of this one.
        await audit(actor, {
          workspaceId: actor.workspaceId,
          action: "workspace.deletion_cancelled",
          entityType: "workspace",
          entityId: actor.workspaceId,
          summary: "Cancelled a scheduled workspace deletion",
        });

        revalidateLayout();
        return { id: actor.workspaceId };
      },
    ),
  );
}

/**
 * Deletes a workspace immediately, skipping the grace period.
 *
 * Kept because "I need this gone now" is a legitimate request — a mistaken
 * import of somebody else's data, a compliance instruction. It requires the name
 * retyped *and* the workspace to already be scheduled, so nobody reaches it
 * without having passed through the reversible path first.
 */
export async function deleteWorkspace(
  id: string,
  confirmation: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: id, permission: "workspace:delete", rateLimit: "mutation" },
      async (actor) => {
        const workspace = await db.workspace.findUniqueOrThrow({
          where: { id: actor.workspaceId },
          select: { name: true, deletionScheduledAt: true },
        });
        assertConfirmation(confirmation, workspace.name);

        if (!workspace.deletionScheduledAt) {
          throw new AppError(
            "conflict",
            "Schedule the deletion first. This gives you a week to change your mind, " +
              "and this action skips it.",
          );
        }

        // The audit entry is written *before* the delete, because the workspace
        // row it references disappears with the cascade.
        await audit(actor, {
          workspaceId: null,
          action: "workspace.deleted",
          entityType: "workspace",
          entityId: actor.workspaceId,
          summary: `Permanently deleted workspace ${workspace.name} (grace period skipped)`,
        });

        await db.workspace.delete({ where: { id: actor.workspaceId } });

        revalidateLayout();
        return { id: actor.workspaceId };
      },
    ),
  );
}

/**
 * Sets whether CRM content from this workspace may be sent to a model provider.
 *
 * Workspace-level rather than account-level: one person may run their own
 * business and a client's in the same account, under different obligations.
 */
export async function setAiMode(
  workspaceId: string,
  mode: string,
): Promise<ActionResult<{ mode: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "workspace:manage", rateLimit: "mutation" },
      async (actor) => {
        const { AI_MODES } = await import("@/lib/ai/privacy");
        const parsed = z.enum(AI_MODES).parse(mode);

        const before = await db.workspace.findUniqueOrThrow({
          where: { id: actor.workspaceId },
          select: { aiMode: true },
        });

        await db.workspace.update({
          where: { id: actor.workspaceId },
          data: { aiMode: parsed },
        });

        await audit(actor, {
          workspaceId: actor.workspaceId,
          action: "ai.privacy_changed",
          entityType: "workspace",
          entityId: actor.workspaceId,
          summary: `AI mode changed from ${before.aiMode} to ${parsed}`,
          metadata: { from: before.aiMode, to: parsed },
        });

        revalidateLayout();
        revalidatePathSafely("/settings/ai");
        return { mode: parsed };
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

const memberRoleSchema = z.object({
  workspaceId: zId,
  userId: zId,
  role: z.enum(ROLES),
});

/**
 * Changes a member's role.
 *
 * Three separate rules apply, all server-side:
 *   - the actor needs `members:manage` in *that* workspace;
 *   - `assertCanAssignRole` stops a role being granted at or above the actor's
 *     own level, so an admin cannot mint an owner;
 *   - the last owner cannot be demoted, which would leave the workspace with
 *     nobody able to delete or bill it.
 */
export async function changeMemberRole(
  input: z.input<typeof memberRoleSchema>,
): Promise<ActionResult<{ userId: string; role: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = memberRoleSchema.parse(input);
        const workspaceId = actor.workspaceId;

        assertCanAssignRole(actor, data.role);

        const target = await db.workspaceMember.findFirst({
          where: { workspaceId, userId: data.userId },
          select: { id: true, role: true },
        });
        if (!target) throw new AppError("not_found", "That person is not in this workspace.");

        if (target.role === "owner" && data.role !== "owner") {
          const owners = await db.workspaceMember.count({ where: { workspaceId, role: "owner" } });
          if (owners <= 1) {
            throw new AppError(
              "conflict",
              "Promote another owner before changing this one — a workspace must always have one.",
            );
          }
        }

        await db.workspaceMember.updateMany({
          where: { workspaceId, userId: data.userId },
          data: { role: data.role },
        });

        await audit(actor, {
          workspaceId,
          action: "member.role_changed",
          entityType: "user",
          entityId: data.userId,
          summary: `Changed a member's role to ${data.role}`,
          metadata: { from: target.role, to: data.role },
        });

        revalidateLayout();
        return { userId: data.userId, role: data.role };
      },
    ),
  );
}

export async function removeMember(
  workspaceId: string,
  userId: string,
): Promise<ActionResult<{ userId: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "members:manage", rateLimit: "mutation" },
      async (actor) => {
        const targetId = zId.parse(userId);
        const scopedWorkspaceId = actor.workspaceId;

        const target = await db.workspaceMember.findFirst({
          where: { workspaceId: scopedWorkspaceId, userId: targetId },
          select: { role: true },
        });
        if (!target) throw new AppError("not_found", "That person is not in this workspace.");

        if (target.role === "owner") {
          const owners = await db.workspaceMember.count({
            where: { workspaceId: scopedWorkspaceId, role: "owner" },
          });
          if (owners <= 1) {
            throw new AppError("conflict", "A workspace must always have at least one owner.");
          }
        }

        await db.workspaceMember.deleteMany({
          where: { workspaceId: scopedWorkspaceId, userId: targetId },
        });

        await audit(actor, {
          workspaceId: scopedWorkspaceId,
          action: "member.removed",
          entityType: "user",
          entityId: targetId,
          summary: "Removed a member from the workspace",
        });

        revalidateLayout();
        return { userId: targetId };
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Project statuses
// ---------------------------------------------------------------------------

export async function createProjectStatus(
  workspaceId: string,
  input: { name: string; color?: string; isTerminal?: boolean },
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "workspace:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = z
          .object({
            name: zShortText.min(1, "Name the status"),
            color: zColor.optional(),
            isTerminal: z.boolean().optional(),
          })
          .parse(input);

        const scoped = actor.workspaceId;
        const count = await db.projectStatus.count({ where: { workspaceId: scoped } });
        const key =
          data.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || `status_${count}`;

        const status = await db.projectStatus.create({
          data: {
            workspaceId: scoped,
            name: data.name,
            key,
            color: data.color ?? "#94a3b8",
            order: count,
            isTerminal: data.isTerminal ?? false,
          },
          select: { id: true },
        });

        revalidatePathSafely("/settings/statuses");
        revalidatePathSafely("/projects");
        return { id: status.id };
      },
    ),
  );
}

export async function deleteProjectStatus(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("projectStatus", id, { permission: "workspace:manage", rateLimit: "mutation" },
      async ({ workspaceId, recordId }) => {
        const status = await db.projectStatus.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { _count: { select: { projects: true } } },
        });
        if (status._count.projects > 0) {
          throw new AppError(
            "conflict",
            "Move the projects in this status somewhere else first.",
          );
        }
        await db.projectStatus.delete({ where: { id: recordId } });
        revalidatePathSafely("/settings/statuses");
        return { id: recordId };
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export async function createPipeline(
  workspaceId: string,
  input: { name: string; kind: "deal" | "opportunity"; stages: string[] },
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "pipelines:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = z
          .object({
            name: zShortText.min(1, "Name the pipeline"),
            kind: z.enum(["deal", "opportunity"]),
            stages: z.array(zShortText.min(1)).min(2, "A pipeline needs at least two stages").max(20),
          })
          .parse(input);

        const scoped = actor.workspaceId;
        const count = await db.pipeline.count({ where: { workspaceId: scoped } });

        const pipeline = await db.pipeline.create({
          data: {
            workspaceId: scoped,
            name: data.name,
            kind: data.kind,
            order: count,
            stages: {
              create: data.stages.map((name, i) => ({
                name,
                order: i,
                // Spread base win rates evenly, with the last stage as the win.
                probability: Math.round(((i + 1) / data.stages.length) * 100),
                kind: i === data.stages.length - 1 ? "won" : "open",
                color: i === data.stages.length - 1 ? "#068C28" : "#94a3b8",
              })),
            },
          },
          select: { id: true },
        });

        await audit(actor, {
          workspaceId: scoped, action: "pipeline.changed", entityType: "pipeline",
          entityId: pipeline.id, summary: `Created pipeline ${data.name}`,
        });

        revalidatePathSafely("/settings/pipelines");
        revalidatePathSafely("/deals");
        return { id: pipeline.id };
      },
    ),
  );
}

export async function createPipelineStage(
  pipelineId: string,
  input: { name: string; probability?: number; color?: string; kind?: string },
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("pipeline", pipelineId, { permission: "pipelines:manage", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const data = z
          .object({
            name: zShortText.min(1, "Name the stage"),
            probability: z.coerce.number().int().min(0).max(100).optional(),
            color: zColor.optional(),
            kind: z.enum(["open", "won", "lost"]).optional(),
          })
          .parse(input);

        const count = await db.pipelineStage.count({ where: { pipelineId: recordId } });
        const stage = await db.pipelineStage.create({
          data: {
            pipelineId: recordId,
            name: data.name,
            order: count,
            probability: data.probability ?? 50,
            color: data.color ?? "#94a3b8",
            kind: data.kind ?? "open",
          },
          select: { id: true },
        });

        await audit(actor, {
          workspaceId, action: "pipeline.changed", entityType: "pipeline",
          entityId: recordId, summary: `Added stage ${data.name}`,
        });

        revalidatePathSafely("/settings/pipelines");
        revalidatePathSafely("/deals");
        return { id: stage.id };
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export async function createCustomField(
  workspaceId: string,
  input: { entityType: string; label: string; type: string; options?: string[] },
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "fields:manage", rateLimit: "mutation" },
      async (actor) => {
        const data = z
          .object({
            entityType: z.enum(["contact", "company", "deal", "project", "opportunity", "task"]),
            label: zShortText.min(1, "Name the field"),
            type: z.enum(["text", "number", "date", "select", "checkbox", "url", "currency"]),
            options: z.array(zShortText.min(1)).max(50).optional(),
          })
          .parse(input);

        const scoped = actor.workspaceId;
        await assertWithinLimit(actor, "customFields");

        const key = data.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
        const count = await db.customFieldDef.count({
          where: { workspaceId: scoped, entityType: data.entityType },
        });

        const field = await db.customFieldDef.create({
          data: {
            workspaceId: scoped,
            entityType: data.entityType,
            key,
            label: data.label,
            type: data.type,
            options: data.options?.length ? JSON.stringify(data.options) : null,
            order: count,
          },
          select: { id: true },
        });

        await audit(actor, {
          workspaceId: scoped, action: "field.changed", entityType: "customField",
          entityId: field.id, summary: `Created custom field ${data.label}`,
        });

        revalidatePathSafely("/settings/fields");
        return { id: field.id };
      },
    ),
  );
}

export async function deleteCustomField(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("customFieldDef", id, { permission: "fields:manage", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await db.customFieldDef.delete({ where: { id: recordId } });
        await audit(actor, {
          workspaceId, action: "field.changed", entityType: "customField",
          entityId: recordId, summary: "Deleted a custom field",
        });
        revalidatePathSafely("/settings/fields");
        return { id: recordId };
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function createTag(
  workspaceId: string,
  name: string,
  color?: string,
): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId, permission: "record:edit", rateLimit: "mutation" },
      async (actor) => {
        const data = z
          .object({ name: zShortText.min(1, "Name the tag").max(60), color: zColor.optional() })
          .parse({ name, color });

        const tag = await db.tag.upsert({
          where: { workspaceId_name: { workspaceId: actor.workspaceId, name: data.name } },
          create: { workspaceId: actor.workspaceId, name: data.name, color: data.color ?? "#068C28" },
          update: data.color ? { color: data.color } : {},
          select: { id: true },
        });

        revalidatePathSafely("/settings/tags");
        return { id: tag.id };
      },
    ),
  );
}

export async function deleteTag(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("tag", id, { rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        // Tag management is an admin concern even though tagging is not, so the
        // permission is asserted here rather than on the record lookup.
        requireRole(actor, "workspace:manage");

        await transaction(async (tx) => {
          await tx.tagLink.deleteMany({ where: { tagId: recordId, workspaceId } });
          await tx.tag.delete({ where: { id: recordId } });
        });

        revalidatePathSafely("/settings/tags");
        revalidateRecord(["/contacts", "/companies"]);
        return { id: recordId };
      },
    ),
  );
}
