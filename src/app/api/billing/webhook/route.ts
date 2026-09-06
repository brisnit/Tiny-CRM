import { NextResponse } from "next/server";
import { z } from "zod";

import { applyPlanChange } from "@/lib/entitlements";
import { billingSecret, claimWebhookEvent, verifySignature } from "@/lib/billing/webhook";
import { recordAudit } from "@/lib/audit";
import { AppError, toAppError } from "@/lib/errors";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { clientAddress, enforceRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { PLAN_ORDER } from "@/lib/plans";

/**
 * Billing webhook — the only path that may change a user's plan.
 *
 * The prototype let the browser call `changePlan()` directly, so any user could
 * grant themselves the Lifetime plan (F-04). Entitlements now move only on a
 * signed, timestamped, idempotent server-to-server call.
 */

export const dynamic = "force-dynamic";

const payloadSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(["subscription.activated", "subscription.cancelled", "payment.succeeded"]),
  userEmail: z.string().email(),
  plan: z.enum(PLAN_ORDER as [string, ...string[]]),
  customerId: z.string().max(200).optional(),
  renewsAt: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  const requestId = newRequestId();

  return runWithContext({ requestId, route: "billing.webhook" }, async () => {
    try {
      await enforceRateLimit("webhook", clientAddress(request.headers));

      const body = await request.text();
      verifySignature({
        body,
        signatureHeader: request.headers.get("x-tinycrm-signature"),
        timestampHeader: request.headers.get("x-tinycrm-timestamp"),
        secret: billingSecret(),
      });

      const payload = payloadSchema.parse(JSON.parse(body));

      const fresh = await claimWebhookEvent("billing", payload.eventId);
      if (!fresh) {
        return NextResponse.json({ ok: true, deduped: true }, { headers: { "x-request-id": requestId } });
      }

      const user = await db.user.findUnique({
        where: { email: payload.userEmail.toLowerCase() },
        select: { id: true, email: true, plan: true },
      });
      // A 200 is returned for an unknown user so the provider does not retry
      // forever on an account that was deleted on our side.
      if (!user) {
        log.warn("billing webhook for unknown user", { eventId: payload.eventId });
        return NextResponse.json({ ok: true, ignored: "unknown_user" });
      }

      const nextPlan = payload.type === "subscription.cancelled" ? "free" : payload.plan;

      await applyPlanChange(user.id, nextPlan as never, {
        status: payload.type === "subscription.cancelled" ? "cancelled" : "active",
        renewsAt: payload.renewsAt ? new Date(payload.renewsAt) : null,
        customerId: payload.customerId ?? null,
      });

      await recordAudit({
        actorId: null,
        actorEmail: "billing-webhook",
        action: "billing.plan_changed",
        entityType: "user",
        entityId: user.id,
        summary: `Plan changed from ${user.plan} to ${nextPlan} by ${payload.type}`,
        metadata: { eventId: payload.eventId, type: payload.type, from: user.plan, to: nextPlan },
      });

      log.info("billing webhook applied", { eventId: payload.eventId, type: payload.type });
      return NextResponse.json({ ok: true }, { headers: { "x-request-id": requestId } });
    } catch (raw) {
      const error = raw instanceof AppError ? raw : toAppError(raw);
      if (error.category === "internal") {
        log.error("billing webhook failed", { error: String(error.internal) });
      } else {
        log.warn("billing webhook rejected", { category: error.category });
      }
      return NextResponse.json(
        { ok: false, error: error.message, requestId },
        { status: error.status, headers: { "x-request-id": requestId } },
      );
    }
  });
}
