import "server-only";

import { db } from "@/lib/db";
import { forbidden, noSuchRecord, unauthorized } from "@/lib/errors";
import { enrichContext } from "@/lib/logger";
import {
  getIdentity, getMemberships, requireIdentity,
  type Identity, type WorkspaceMembership,
} from "@/lib/auth/context";
import { can, canAssignRole, type Permission, type Role } from "@/lib/auth/permissions";
import { assertVerified, verificationEnforced } from "@/lib/auth/verification";
import { mailConfigured } from "@/lib/mail";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Server-side authorization.
 *
 * Every protected operation goes through these helpers. The rule they all
 * express is the same one:
 *
 *   authenticated user → workspace membership → permitted resources
 *
 * A workspace id from the browser is never trusted on its own; it is only ever
 * used to *select* from the set of workspaces the user is already a member of.
 * A record id from the browser is never used in a `where` clause without the
 * workspace filter beside it.
 *
 * Failures return "not found" rather than "forbidden" — confirming that an id
 * exists but belongs to someone else is itself a disclosure.
 */

export type Actor = {
  identity: Identity;
  memberships: WorkspaceMembership[];
};

export type WorkspaceActor = Actor & {
  workspaceId: string;
  role: Role;
  can: (permission: Permission) => boolean;
};

/** The authenticated user, or an unauthorized error. */
export async function requireUser(): Promise<Identity> {
  return requireIdentity();
}

export async function getActor(): Promise<Actor | null> {
  const identity = await getIdentity();
  if (!identity) return null;
  return { identity, memberships: await getMemberships(identity.id) };
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw unauthorized();
  return actor;
}

/**
 * Asserts membership of one workspace and, optionally, a permission within it.
 * Returns an actor bound to that workspace.
 */
export async function requireWorkspaceAccess(
  workspaceId: string,
  permission?: Permission,
): Promise<WorkspaceActor> {
  const actor = await requireActor();
  const membership = actor.memberships.find((m) => m.id === workspaceId);

  // Not a member: indistinguishable from the workspace not existing.
  if (!membership) throw noSuchRecord();

  if (permission && !can(membership.role, permission)) {
    throw forbidden(`Your role (${membership.role}) cannot ${describe(permission)}.`);
  }

  // Checked *after* the permission, deliberately. The other order tells an
  // under-privileged user that confirming their email would help, which is not
  // true and sends them down the wrong path.
  if (permission) {
    assertVerified(actor.identity, permission, {
      enforced: verificationEnforced(mailConfigured()),
    });
  }

  enrichContext({ workspaceId });
  return {
    ...actor,
    workspaceId,
    role: membership.role,
    can: (p: Permission) => can(membership.role, p),
  };
}

/** Asserts a permission the caller already holds a workspace actor for. */
export function requireRole(actor: WorkspaceActor, permission: Permission): void {
  if (!actor.can(permission)) {
    throw forbidden(`Your role (${actor.role}) cannot ${describe(permission)}.`);
  }
}

export function assertCanAssignRole(actor: WorkspaceActor, targetRole: string): void {
  if (!canAssignRole(actor.role, targetRole)) {
    throw forbidden(`Your role (${actor.role}) cannot grant the ${targetRole} role.`);
  }
}

/**
 * Resolves the workspace ids a read may touch.
 *
 * `scope` is either one workspace id or "all". An id the user is not a member of
 * silently falls back to their full set rather than erroring, because a stale
 * cookie must not lock someone out of their own account — and it can never widen
 * access, only narrow it.
 */
export async function resolveReadScope(
  scope: string | null | undefined,
): Promise<{ workspaceIds: string[]; workspaceId: string | null; isAll: boolean; memberships: WorkspaceMembership[] }> {
  const actor = await requireActor();
  const ids = actor.memberships.map((m) => m.id);

  if (!scope || scope === "all" || !ids.includes(scope)) {
    return { workspaceIds: ids, workspaceId: null, isAll: true, memberships: actor.memberships };
  }
  enrichContext({ workspaceId: scope });
  return { workspaceIds: [scope], workspaceId: scope, isAll: false, memberships: actor.memberships };
}

// ---------------------------------------------------------------------------
// Record-level access
// ---------------------------------------------------------------------------

/** Models addressable by id that carry a `workspaceId`. */
export const SCOPED_MODELS = [
  "contact", "company", "deal", "project", "opportunity",
  "task", "note", "activity", "fileAsset", "pipeline", "automation",
  "projectStatus", "customFieldDef", "tag", "aiInsight", "milestone",
] as const;
export type ScopedModel = (typeof SCOPED_MODELS)[number];

/**
 * Loads a record by id **scoped to the workspaces the caller belongs to**, and
 * returns it with its workspace id. This is the helper that closes the IDOR
 * class of bug: there is no way to call it that reads outside the tenant.
 */
export async function requireRecordAccess<T extends ScopedModel>(
  model: T,
  id: string,
  options: { permission?: Permission; workspaceId?: string } = {},
): Promise<{ id: string; workspaceId: string; actor: WorkspaceActor }> {
  const actor = await requireActor();
  const allowed = actor.memberships.map((m) => m.id);
  if (allowed.length === 0) throw noSuchRecord();

  const where =
    model === "milestone"
      ? { id, project: { workspaceId: { in: allowed } } }
      : { id, workspaceId: { in: allowed } };

  // The lookup that resolves a record to its workspace runs in a context of
  // every workspace this actor belongs to. That is the chicken-and-egg of
  // record-scoped authorisation — the workspace is not known until the record is
  // read — resolved without weakening anything: the row is visible only if it
  // lives in one of the caller's own workspaces, so RLS is now *making* the
  // authorisation decision rather than being consulted after it. Outside a
  // context this read returned nothing for every record, and every member
  // operation failed with "not found".
  const record = await withTenantContext(
    { workspaceIds: allowed, userId: actor.identity.id },
    async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)[model].findFirst({
        where,
        select:
          model === "milestone"
            ? { id: true, project: { select: { workspaceId: true } } }
            : { id: true, workspaceId: true },
      }),
  );

  if (!record) throw noSuchRecord();

  const workspaceId: string =
    model === "milestone" ? record.project.workspaceId : record.workspaceId;

  // A caller may pin the expected workspace; a mismatch is an attempt to act
  // across tenants even though both are readable by this user.
  if (options.workspaceId && options.workspaceId !== workspaceId) throw noSuchRecord();

  const bound = await requireWorkspaceAccess(workspaceId, options.permission);
  return { id, workspaceId, actor: bound };
}

/**
 * Relation ids accepted from a client, keyed by the model they must belong to.
 */
export type RelationInput = Partial<Record<ScopedModel, string | null | undefined>>;

const RELATION_FIELD: Record<string, ScopedModel> = {
  contactId: "contact",
  companyId: "company",
  dealId: "deal",
  projectId: "project",
  opportunityId: "opportunity",
  taskId: "task",
  noteId: "note",
  primaryContactId: "contact",
  pipelineId: "pipeline",
  statusId: "projectStatus",
  fieldId: "customFieldDef",
};

/**
 * Validates that every relation id supplied by a client belongs to the target
 * workspace, in one batched query per model.
 *
 * This is the fix for the audit's most widespread finding: before it, a user in
 * workspace A could attach their record to workspace B's contact, pipeline stage
 * or project simply by knowing an id — which leaked the other tenant's data back
 * through their own record page.
 *
 * `stageId` is special-cased because PipelineStage has no `workspaceId` of its
 * own; it is reached through its pipeline.
 *
 * `ownerId` is special-cased for the same reason and matters more: a User has no
 * workspace at all, so the only thing that makes an owner legitimate is a
 * membership row. Without this check, assigning an owner would accept any user
 * id in the system — handing a record to someone outside the tenant, and
 * confirming that account exists by whether the save succeeded.
 */
export async function assertRelations(
  workspaceId: string,
  input: Record<string, string | null | undefined>,
): Promise<void> {
  const byModel = new Map<ScopedModel, Set<string>>();

  for (const [field, value] of Object.entries(input)) {
    if (!value) continue;
    const model = RELATION_FIELD[field];
    if (!model) continue;
    const set = byModel.get(model) ?? new Set<string>();
    set.add(value);
    byModel.set(model, set);
  }

  const checks: Promise<void>[] = [];

  for (const [model, ids] of byModel) {
    checks.push(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const found = await (db as any)[model].findMany({
          where: { id: { in: [...ids] }, workspaceId },
          select: { id: true },
        });
        if (found.length !== ids.size) {
          const missing = [...ids].filter((id) => !found.some((r: { id: string }) => r.id === id));
          throw noSuchRecord();
          // `missing` is intentionally unreported — naming the id would confirm
          // it exists somewhere. It is available here for debugging only.
          void missing;
        }
      })(),
    );
  }

  // An owner is legitimate only if they are a member of this workspace.
  if (input.ownerId) {
    checks.push(
      (async () => {
        const membership = await db.workspaceMember.findFirst({
          where: { workspaceId, userId: input.ownerId! },
          select: { id: true },
        });
        // The same answer as any other unreachable relation, so this cannot be
        // used to probe which user ids exist.
        if (!membership) throw noSuchRecord();
      })(),
    );
  }

  // A pipeline stage belongs to a workspace via its pipeline.
  if (input.stageId) {
    checks.push(
      (async () => {
        const stage = await db.pipelineStage.findFirst({
          where: { id: input.stageId!, pipeline: { workspaceId } },
          select: { id: true, pipelineId: true },
        });
        if (!stage) throw noSuchRecord();
        // If a pipeline was also supplied, the stage must belong to it — otherwise
        // a deal could sit in a stage from a different pipeline in the same workspace.
        if (input.pipelineId && stage.pipelineId !== input.pipelineId) {
          throw noSuchRecord();
        }
      })(),
    );
  }

  await Promise.all(checks);
}

function describe(permission: Permission): string {
  const [subject, verb] = permission.split(":");
  return `${verb} ${subject === "record" ? "records" : subject}`;
}
