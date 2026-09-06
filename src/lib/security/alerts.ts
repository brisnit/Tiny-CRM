import "server-only";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { log, redact } from "@/lib/logger";

/**
 * Security alerting.
 *
 * Deliberately a different thing from the audit log, and the distinction is the
 * point of this module:
 *
 *   **AUDIT EVENT** — a complete, append-only record of what happened. Written
 *   for every consequential action, whether or not anyone should care. Its value
 *   is completeness; its consumer is an investigation, after the fact.
 *
 *   **SECURITY ALERT** — the small subset someone should look at. Its value is
 *   signal; its consumer is a person, now. An alert that fires on everything is
 *   an alert nobody reads, which is worse than no alert at all because it looks
 *   like coverage.
 *
 * So: every alert is also audited, and almost no audit entry becomes an alert.
 *
 * Alerts are **deduplicated** rather than emitted per occurrence. Fifty failed
 * sign-ins is one alert with a count of fifty, not fifty alerts — the burst is
 * the signal, and fifty copies of it would bury everything else.
 */

export const SECURITY_ALERTS = {
  // --- Authentication -------------------------------------------------------
  "auth.repeated_failures": {
    severity: "warning",
    title: "Repeated failed sign-ins",
    why: "Credential stuffing, or a legitimate user locked out of their own account.",
  },
  "auth.account_locked": {
    severity: "warning",
    title: "Account locked after repeated failures",
    why: "The threshold was reached. Either an attack, or someone who needs help.",
  },
  "auth.sign_in_new_location": {
    severity: "info",
    title: "Sign-in from an unfamiliar network",
    why: "Routine for travel, and the first observable sign of a stolen session.",
  },
  "password.reset_completed": {
    severity: "info",
    title: "Password reset completed",
    why: "Normal — unless the account owner did not request it.",
  },
  "mfa.enabled": { severity: "info", title: "Two-factor enabled", why: "An account got stronger." },
  "mfa.disabled": {
    severity: "warning",
    title: "Two-factor disabled",
    why: "A control was removed. Attackers do this immediately after a takeover.",
  },

  // --- Authorisation --------------------------------------------------------
  "access.role_escalated": {
    severity: "warning",
    title: "A role was raised",
    why: "Privilege escalation is how a foothold becomes an incident.",
  },
  "access.owner_changed": {
    severity: "critical",
    title: "Workspace ownership changed",
    why: "The owner can delete the workspace and change billing. This is rare and consequential.",
  },
  "access.admin_added": {
    severity: "warning",
    title: "An administrator was added",
    why: "Admins can manage members and settings for the whole workspace.",
  },
  "access.member_removed": {
    severity: "info",
    title: "A member was removed",
    why: "Routine, and also what a departing insider looks like.",
  },
  "access.cross_tenant_denied": {
    severity: "critical",
    title: "Repeated cross-tenant access refused",
    why:
      "One refusal is a stale bookmark. A pattern of them from one account is " +
      "somebody probing the boundary, and it is the single most important signal " +
      "this product can produce.",
  },

  // --- Data movement --------------------------------------------------------
  "data.mass_export": {
    severity: "warning",
    title: "Large export",
    why: "The shape an exfiltration takes. Legitimate most of the time, and worth seeing every time.",
  },
  "data.suspicious_import": {
    severity: "warning",
    title: "Unusually large import",
    why: "A way to inflate storage, and a way to smuggle content past a review.",
  },
  "workspace.deletion_requested": {
    severity: "critical",
    title: "Workspace deletion requested",
    why: "An entire customer's data is scheduled for destruction. The grace period is the chance to stop it.",
  },

  // --- Integrity ------------------------------------------------------------
  "webhook.signature_failed": {
    severity: "warning",
    title: "Webhook signature verification failed",
    why: "Someone is posting to the billing endpoint without the secret.",
  },
  "ai.usage_spike": {
    severity: "warning",
    title: "Unusual AI usage",
    why: "A cost problem, and sometimes an attempt to extract the CRM through the model.",
  },
  "destructive.burst": {
    severity: "critical",
    title: "Burst of destructive activity",
    why: "Mass deletion is what ransomware and a disgruntled insider have in common.",
  },
  "config.rls_inactive": {
    severity: "critical",
    title: "Row-level security is not protecting this connection",
    why: "The database-level tenant isolation layer is off. Application isolation still applies, alone.",
  },
} as const;

export type AlertKind = keyof typeof SECURITY_ALERTS;
export type AlertSeverity = "info" | "warning" | "critical";

export type AlertInput = {
  kind: AlertKind;
  /** Overrides the kind's default severity when context makes it worse. */
  severity?: AlertSeverity;
  summary: string;
  workspaceId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Groups occurrences that should collapse into one alert. Include a time
   * bucket to make an alert re-fire after a quiet period rather than
   * accumulating forever.
   */
  dedupeKey: string;
};

/**
 * Raises an alert, collapsing repeats.
 *
 * Never throws. An alerting failure must not fail the operation that triggered
 * it — an attacker who can make alerting throw could otherwise suppress alerts
 * *and* break the product by causing the condition that raises them.
 */
export async function raiseAlert(input: AlertInput): Promise<void> {
  const definition = SECURITY_ALERTS[input.kind];
  const severity = input.severity ?? definition.severity;

  try {
    const alert = await db.securityAlert.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        kind: input.kind,
        severity,
        summary: input.summary.slice(0, 500),
        workspaceId: input.workspaceId ?? null,
        userId: input.userId ?? null,
        // Same redaction as the audit log. An alert about a credential problem
        // must not carry the credential.
        metadata: input.metadata ? JSON.stringify(redact(input.metadata)) : null,
        dedupeKey: input.dedupeKey,
      },
      update: {
        count: { increment: 1 },
        lastSeenAt: new Date(),
        // A repeat re-opens an acknowledged alert: the same condition happening
        // again is new information.
        acknowledgedAt: null,
        acknowledgedById: null,
        deliveredAt: null,
      },
      select: { id: true, count: true, severity: true },
    });

    log.warn("security alert", {
      kind: input.kind,
      severity,
      count: alert.count,
      workspaceId: input.workspaceId ?? undefined,
    });

    // Delivery is fire-and-forget. A slow webhook must not slow a sign-in.
    void deliver(alert.id, input.kind, severity, input.summary, alert.count).catch((error) => {
      log.error("alert delivery failed", { kind: input.kind, error: String(error) });
    });
  } catch (error) {
    log.error("could not raise a security alert", { kind: input.kind, error: String(error) });
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Sends an alert to the configured sink.
 *
 * Three adapters, all provider-independent:
 *
 *   log      structured, always on. The floor: an alert is never lost, even
 *            when nothing else is configured.
 *   webhook  a JSON POST. Slack, Discord, PagerDuty and Opsgenie all accept one.
 *   none     explicitly nothing, for a deployment that reads the table directly.
 *
 * The payload deliberately carries **no CRM content** — a kind, a severity, a
 * count and an id. Whoever receives it looks the rest up in a place that has
 * access control; an alerting channel usually does not.
 */
async function deliver(
  alertId: string,
  kind: AlertKind,
  severity: AlertSeverity,
  summary: string,
  count: number,
): Promise<void> {
  if (!env.alertWebhookUrl) {
    await db.securityAlert.update({
      where: { id: alertId },
      data: { deliveredAt: new Date() },
    });
    return;
  }

  // Below the configured floor: recorded, not delivered.
  const order: AlertSeverity[] = ["info", "warning", "critical"];
  if (order.indexOf(severity) < order.indexOf(env.alertMinSeverity as AlertSeverity)) {
    return;
  }

  try {
    const response = await fetch(env.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Slack and Discord both render `text`; everything else is ignored by
        // them and used by a real alerting system.
        text: `[${severity.toUpperCase()}] ${SECURITY_ALERTS[kind].title}${count > 1 ? ` (×${count})` : ""} — ${summary}`,
        kind,
        severity,
        count,
        alertId,
        at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    });

    await db.securityAlert.update({
      where: { id: alertId },
      data: response.ok
        ? { deliveredAt: new Date(), deliveryError: null }
        : { deliveryError: `Sink returned ${response.status}` },
    });
  } catch (error) {
    await db.securityAlert.update({
      where: { id: alertId },
      data: { deliveryError: String(error).slice(0, 300) },
    });
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listAlerts(
  workspaceIds: string[],
  options: { includeAcknowledged?: boolean; limit?: number } = {},
) {
  return db.securityAlert.findMany({
    where: {
      OR: [{ workspaceId: { in: workspaceIds } }, { workspaceId: null }],
      ...(options.includeAcknowledged ? {} : { acknowledgedAt: null }),
    },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
    take: Math.min(options.limit ?? 50, 200),
  });
}

export async function acknowledgeAlert(
  alertId: string,
  actorId: string,
  workspaceIds: string[],
): Promise<boolean> {
  // Scoped: an alert id from another tenant matches nothing.
  const result = await db.securityAlert.updateMany({
    where: {
      id: alertId,
      OR: [{ workspaceId: { in: workspaceIds } }, { workspaceId: null }],
      acknowledgedAt: null,
    },
    data: { acknowledgedAt: new Date(), acknowledgedById: actorId },
  });
  return result.count > 0;
}

/**
 * Bucket for a dedupe key, so a condition re-alerts after a quiet period rather
 * than folding into an alert from last week.
 */
export function alertWindow(minutes = 60): string {
  return String(Math.floor(Date.now() / (minutes * 60_000)));
}
