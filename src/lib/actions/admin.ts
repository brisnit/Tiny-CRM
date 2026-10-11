"use server";

import { z } from "zod";

import { audit, guard, revalidatePathSafely, type ActionResult } from "@/lib/actions/base";
import { requirePlatformAdmin, refuseSelfTarget } from "@/lib/admin/authorize";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { activeGrantWhere, effectiveFrom, GRANT_SELECT } from "@/lib/plan-grants";
import { GRANTABLE_PLANS, isLegacyPlan } from "@/lib/plans";
import { NO_RECORD_READS, withTenantContext } from "@/lib/tenant-db";

/**
 * Administrative mutations.
 *
 * ## Every one of these is a transaction containing its own audit entry
 *
 * Not "the mutation, then the audit" — the two are written together or neither
 * is. An entitlement change that succeeded while its record failed is an
 * unexplained change to a customer's access, and an audit entry whose mutation
 * rolled back is a record of something that never happened. Both are worse
 * than the operation failing, and both are possible the moment the write and
 * the record are separate round trips.
 *
 * ## Where the audit entry is scoped
 *
 * `workspaceId` is deliberately **null** and `actorId` is the admin. The
 * existing `AuditLog` policy reads an orphaned row only for the actor who
 * wrote it, so this makes the administrative trail visible to the admin who
 * made it without widening anything for anyone. The target account is carried
 * in `entityType`/`entityId` and in the metadata, where it is data rather than
 * a tenancy claim.
 *
 * This does not fix the known billing-audit defect — rows written by the
 * Stripe webhook carry neither an actor nor a workspace and remain invisible.
 * Widening the policy to surface them would expose every service-written row
 * to any caller the predicate admitted, which is a larger hole than the one it
 * closes. It is documented in docs/ADMIN-PANEL.md rather than papered over.
 *
 * ## Authorization
 *
 * Each action calls `requirePlatformAdmin()` itself. No wrapper, no layout and
 * no middleware stands in for it: a server action is reachable by POST whether
 * or not any page rendered, so an action that relies on something upstream is
 * an unauthenticated endpoint with a comment claiming otherwise.
 */

/**
 * Runs an administrative write with the admin's identity in scope.
 *
 * Two things depend on this, and both were found by running the suite against
 * PostgreSQL as the restricted role rather than as the owner.
 *
 * `AuditLog`'s policy admits an orphaned row — no workspace — only when
 * `"actorId" = app_user_id()`. These actions write exactly such a row, so
 * without `app.user_id` set the insert is refused with 42501 and the whole
 * operation fails. A plain `db.$transaction()` sets nothing.
 *
 * The workspace list is empty and `NO_RECORD_READS` is explicit: this context
 * exists to carry an *identity*, not a tenancy. It grants no workspace access,
 * so the cross-tenant reads the panel performs still rest on the admin's own
 * RLS policy rather than on anything claimed here.
 */
async function adminWrite<T>(
  adminUserId: string,
  fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withTenantContext(
    { workspaceIds: [], userId: adminUserId, restrictedWorkspaceIds: NO_RECORD_READS },
    async () => db.$transaction(fn),
  );
}

const grantSchema = z.object({
  userId: z.string().min(1).max(64),
  plan: z.enum(GRANTABLE_PLANS),
  reason: z.string().trim().min(3).max(500),
  /** `YYYY-MM-DD`, or empty for open-ended. */
  expiresOn: z.string().trim().max(10).optional(),
});

const revokeSchema = z.object({
  userId: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(500),
});

const suspendSchema = z.object({
  userId: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(500),
});

/** Parses an optional `YYYY-MM-DD` into an end-of-day instant, or null. */
function expiryFrom(value: string | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new AppError("validation", "Give the expiry as YYYY-MM-DD, or leave it empty.");
  // End of the named day, so "expires 2026-12-31" includes the 31st rather
  // than ending at midnight as it begins.
  const at = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(at.getTime())) throw new AppError("validation", "That is not a date.");
  if (at.getTime() <= Date.now()) {
    throw new AppError("validation", "That expiry is already in the past.");
  }
  return at;
}

/** The target account, with its live grants, or a refusal. */
async function loadTarget(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      plan: true,
      deactivatedAt: true,
      deactivatedReason: true,
      planGrants: { where: activeGrantWhere(), select: GRANT_SELECT },
    },
  });
  if (!user) throw new AppError("not_found", "No such account.");
  return user;
}

/**
 * Grants, or changes, complimentary access.
 *
 * Changing is implemented as revoke-and-replace inside one transaction rather
 * than an update, so the history reads as what happened: this grant ended,
 * that one began, each with its own reason. An update would overwrite the
 * reason the earlier access was given for.
 */
export async function grantComplimentaryPlan(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = grantSchema.parse(input);
    const expiresAt = expiryFrom(parsed.expiresOn);

    const target = await loadTarget(parsed.userId);
    const before = effectiveFrom(target.plan, target.planGrants);

    // A grant may only ever add. Refused rather than silently stored as a
    // no-op, because an operator who grants Plus to a Pro account has
    // misunderstood something and should be told, not quietly agreed with.
    if (isLegacyPlan(before.underlying)) {
      throw new AppError(
        "validation",
        `This account is on ${before.underlying.replace("_", " ")}, which already includes more ` +
          `than a complimentary plan can add. Granting would change nothing.`,
      );
    }
    const after = effectiveFrom(target.plan, [
      { id: "pending", plan: parsed.plan, reason: parsed.reason, expiresAt },
    ]);
    if (after.effective === before.effective && !before.grant) {
      throw new AppError(
        "validation",
        `This account already has ${before.effective} access, so a complimentary ` +
          `${parsed.plan} grant would not change what it can do.`,
      );
    }

    await adminWrite(admin.identity.id, async (tx) => {
      // Supersede anything live, so there is never more than one grant in
      // force and the panel never has to explain which of two applies.
      await tx.planGrant.updateMany({
        where: { userId: target.id, ...activeGrantWhere() },
        data: {
          revokedAt: new Date(),
          revokedById: admin.identity.id,
          revokedReason: `Superseded by a ${parsed.plan} grant`,
        },
      });

      const created = await tx.planGrant.create({
        data: {
          userId: target.id,
          plan: parsed.plan,
          reason: parsed.reason,
          expiresAt,
          grantedById: admin.identity.id,
        },
        select: { id: true },
      });

      await audit(
        admin,
        {
          workspaceId: null,
          action: "admin.plan_grant_created",
          entityType: "user",
          entityId: target.id,
          summary:
            `Granted complimentary ${parsed.plan} to ${target.email}` +
            (expiresAt ? ` until ${expiresAt.toISOString().slice(0, 10)}` : " with no expiry"),
          metadata: {
            grantId: created.id,
            reason: parsed.reason,
            expiresAt: expiresAt?.toISOString() ?? null,
            // Before and after, as the entitlement actually resolves — not
            // just the column, which does not change at all here.
            before: { stored: before.stored, effective: before.effective, grant: before.granted },
            after: { stored: before.stored, effective: after.effective, grant: parsed.plan },
            // Stated in the record because it is the question someone will ask
            // of this entry later.
            stripe: "unchanged: a grant creates no subscription and charges nothing",
          },
        },
        tx,
        { required: true },
      );
    });

    // Safely: `revalidatePath` throws outside a request scope, and it runs
    // *after* the transaction has committed — so an unguarded call reports
    // failure for a change that was in fact applied, which is the worst of
    // both answers. The codebase already has the guarded form.
    revalidatePathSafely("/admin");
    revalidatePathSafely(`/admin/customers/${target.id}`);
    return { ok: true, data: undefined };
  });
}

/** Ends complimentary access. The underlying plan is untouched and resumes. */
export async function revokeComplimentaryPlan(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = revokeSchema.parse(input);

    const target = await loadTarget(parsed.userId);
    const before = effectiveFrom(target.plan, target.planGrants);
    if (!before.grant) throw new AppError("validation", "That account has no complimentary access.");

    // What they fall back to. Computed from the stored column, which no grant
    // ever wrote to — so this is a statement about what is already true, not a
    // restore operation that could itself go wrong.
    const after = effectiveFrom(target.plan, []);

    await adminWrite(admin.identity.id, async (tx) => {
      await tx.planGrant.updateMany({
        where: { userId: target.id, ...activeGrantWhere() },
        data: {
          revokedAt: new Date(),
          revokedById: admin.identity.id,
          revokedReason: parsed.reason,
        },
      });

      await audit(
        admin,
        {
          workspaceId: null,
          action: "admin.plan_grant_revoked",
          entityType: "user",
          entityId: target.id,
          summary: `Revoked complimentary ${before.granted} from ${target.email}`,
          metadata: {
            reason: parsed.reason,
            before: { stored: before.stored, effective: before.effective, grant: before.granted },
            after: { stored: after.stored, effective: after.effective, grant: null },
            stripe: "unchanged: revoking a grant cancels nothing and refunds nothing",
          },
        },
        tx,
        { required: true },
      );
    });

    // Safely: `revalidatePath` throws outside a request scope, and it runs
    // *after* the transaction has committed — so an unguarded call reports
    // failure for a change that was in fact applied, which is the worst of
    // both answers. The codebase already has the guarded form.
    revalidatePathSafely("/admin");
    revalidatePathSafely(`/admin/customers/${target.id}`);
    return { ok: true, data: undefined };
  });
}

/**
 * Suspends an account.
 *
 * Reversible, and enforced server-side on the next request rather than at the
 * next sign-in: `getIdentity()` re-reads `deactivatedAt` on every request and
 * returns null when it is set, so an existing session stops working
 * immediately. `sessionEpoch` is bumped as well, which invalidates every
 * issued token outright — belt and braces, and it means a reinstated account
 * starts from a clean set of sessions rather than resuming old ones.
 */
export async function suspendAccount(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = suspendSchema.parse(input);
    refuseSelfTarget(admin, parsed.userId, "suspend");

    const target = await loadTarget(parsed.userId);
    if (target.deactivatedAt) throw new AppError("validation", "That account is already suspended.");

    await adminWrite(admin.identity.id, async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: {
          deactivatedAt: new Date(),
          deactivatedReason: parsed.reason,
          sessionEpoch: { increment: 1 },
        },
      });

      await audit(
        admin,
        {
          workspaceId: null,
          action: "admin.account_suspended",
          entityType: "user",
          entityId: target.id,
          summary: `Suspended ${target.email}`,
          metadata: {
            reason: parsed.reason,
            before: { suspended: false },
            after: { suspended: true },
            sessions: "every existing session invalidated by a session-epoch bump",
            stripe: "unchanged: suspension does not cancel a subscription or issue a refund",
          },
        },
        tx,
        { required: true },
      );
    });

    // Safely: `revalidatePath` throws outside a request scope, and it runs
    // *after* the transaction has committed — so an unguarded call reports
    // failure for a change that was in fact applied, which is the worst of
    // both answers. The codebase already has the guarded form.
    revalidatePathSafely("/admin");
    revalidatePathSafely(`/admin/customers/${target.id}`);
    return { ok: true, data: undefined };
  });
}

/** Reinstates a suspended account. */
export async function reinstateAccount(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = suspendSchema.parse(input);

    const target = await loadTarget(parsed.userId);
    if (!target.deactivatedAt) throw new AppError("validation", "That account is not suspended.");

    await adminWrite(admin.identity.id, async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { deactivatedAt: null, deactivatedReason: null },
      });

      await audit(
        admin,
        {
          workspaceId: null,
          action: "admin.account_reinstated",
          entityType: "user",
          entityId: target.id,
          summary: `Reinstated ${target.email}`,
          metadata: {
            reason: parsed.reason,
            before: { suspended: true, suspendedReason: target.deactivatedReason },
            after: { suspended: false },
            sessions: "the account must sign in again; prior sessions stay invalidated",
          },
        },
        tx,
        { required: true },
      );
    });

    // Safely: `revalidatePath` throws outside a request scope, and it runs
    // *after* the transaction has committed — so an unguarded call reports
    // failure for a change that was in fact applied, which is the worst of
    // both answers. The codebase already has the guarded form.
    revalidatePathSafely("/admin");
    revalidatePathSafely(`/admin/customers/${target.id}`);
    return { ok: true, data: undefined };
  });
}
