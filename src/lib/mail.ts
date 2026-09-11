import "server-only";

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { env, isProduction, isTest } from "@/lib/env";
import { log } from "@/lib/logger";
import { escapeHtml } from "@/lib/sanitize";

/**
 * Outbound email.
 *
 * One interface, three adapters, chosen from configuration:
 *
 *   sink     development. Writes the message to `.mail/outbox.log` and prints a
 *            clickable link to the terminal. Nothing leaves the machine.
 *   log      the fallback when nothing is configured. Records that a message
 *            *would* have been sent, and — importantly — **never writes the
 *            link or the token**, so a production deployment that forgets to
 *            configure a provider does not print password-reset tokens into a
 *            log aggregator.
 *   http     a provider's REST API (Resend, Postmark, SendGrid — anything that
 *            takes a JSON POST with a bearer token).
 *
 * ---------------------------------------------------------------------------
 * The rule that shapes this file
 * ---------------------------------------------------------------------------
 *
 * A password-reset link is a bearer credential for an account. Printing one to
 * a log turns every operator, every log aggregator and every screenshot into a
 * way to take over an account. So:
 *
 *   - the full link is written **only** by the development sink,
 *   - and the development sink refuses to run in production at all.
 *
 * That is enforced below rather than left to a comment.
 */

export type MailMessage = {
  to: string;
  subject: string;
  /** Plain-text body. Always provided; some clients never render HTML. */
  text: string;
  html?: string;
  /**
   * Marks a message as carrying a credential — a reset link, a verification
   * link, a recovery code. These are never logged, whatever the adapter.
   */
  sensitive?: boolean;
};

export type MailResult = {
  delivered: boolean;
  adapter: "sink" | "log" | "http";
  /** Only ever populated by the development sink. */
  previewUrl?: string;
  /**
   * The provider's message id, when it returns one.
   *
   * An opaque identifier, never the content. Without it a delivery complaint
   * cannot be traced to a specific send, and "the provider accepted it" cannot
   * be distinguished from "the provider delivered it" — which is the difference
   * between a working reset flow and one that only looks like it works.
   */
  providerMessageId?: string;
  error?: string;
};

export type MailAdapter = {
  readonly kind: MailResult["adapter"];
  send(message: MailMessage): Promise<MailResult>;
};

// ---------------------------------------------------------------------------

const OUTBOX = resolve(process.cwd(), ".mail");

/**
 * Development sink. Writes the whole message, link included, to a local file
 * and to the terminal — which is the point: without it there is no way to
 * complete a password reset locally.
 */
class SinkAdapter implements MailAdapter {
  readonly kind = "sink" as const;

  async send(message: MailMessage): Promise<MailResult> {
    if (isProduction) {
      // Belt and braces: `selectAdapter` already refuses this, and this is the
      // one mistake whose cost is unbounded.
      throw new Error("The development mail sink must never run in production.");
    }

    const entry =
      `\n${"=".repeat(72)}\n` +
      `To:      ${message.to}\n` +
      `Subject: ${message.subject}\n` +
      `At:      ${new Date().toISOString()}\n` +
      `${"-".repeat(72)}\n${message.text}\n`;

    try {
      mkdirSync(OUTBOX, { recursive: true });
      appendFileSync(resolve(OUTBOX, "outbox.log"), entry, "utf8");
    } catch {
      // A read-only filesystem should not break a sign-up in development.
    }

    // Printed to the terminal so a developer can follow the link. The sink is
    // unreachable in production, checked above.
    if (!isTest) console.log(entry);

    const link = /https?:\/\/\S+/.exec(message.text)?.[0];
    return { delivered: true, adapter: "sink", previewUrl: link };
  }
}

/**
 * The no-provider fallback.
 *
 * Records the attempt without the contents. A deployment reaching this has a
 * broken password-reset flow, which is why it logs at warning level — but a
 * broken flow is far better than one that publishes its own tokens.
 */
class LogAdapter implements MailAdapter {
  readonly kind = "log" as const;

  async send(message: MailMessage): Promise<MailResult> {
    log.warn("email not sent: no mail provider configured", {
      subject: message.subject,
      // The recipient is a personal identifier; only its domain is recorded.
      recipientDomain: message.to.split("@")[1] ?? "unknown",
      carriedCredential: Boolean(message.sensitive),
    });
    return {
      delivered: false,
      adapter: "log",
      error: "No mail provider is configured.",
    };
  }
}

/** A generic provider over HTTPS. */
class HttpAdapter implements MailAdapter {
  readonly kind = "http" as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<MailResult> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // The response body can echo the request, which for these messages
        // means the link. It is never read or logged.
        log.error("mail provider rejected a message", {
          status: response.status,
          subject: message.subject,
        });
        return { delivered: false, adapter: "http", error: `Provider returned ${response.status}` };
      }

      // Only the id is read out of the response. The body echoes the request,
      // which for these messages contains the reset link, so nothing else is
      // touched and nothing else is logged.
      let providerMessageId: string | undefined;
      try {
        const body = (await response.json()) as { id?: unknown };
        if (typeof body?.id === "string") providerMessageId = body.id;
      } catch {
        // A provider that returns no JSON body is fine; the send still worked.
      }

      if (providerMessageId) {
        log.info("mail accepted by provider", { subject: message.subject, providerMessageId });
      }

      return { delivered: true, adapter: "http", providerMessageId };
    } catch (error) {
      log.error("mail provider unreachable", {
        subject: message.subject,
        error: error instanceof Error ? error.message : "unknown",
      });
      return { delivered: false, adapter: "http", error: "Provider unreachable" };
    }
  }
}

// ---------------------------------------------------------------------------

function selectAdapter(): MailAdapter {
  if (env.mailProviderUrl && env.mailProviderToken) {
    return new HttpAdapter(env.mailProviderUrl, env.mailProviderToken, env.mailFrom);
  }
  // The sink is never reachable in production, whatever MAIL_ADAPTER says.
  if (!isProduction && env.mailAdapter !== "log") return new SinkAdapter();
  return new LogAdapter();
}

const globalForMail = globalThis as unknown as { mailAdapter?: MailAdapter };
const adapter: MailAdapter = (globalForMail.mailAdapter ??= selectAdapter());

export async function sendMail(message: MailMessage): Promise<MailResult> {
  return adapter.send(message);
}

export function mailAdapterKind(): MailResult["adapter"] {
  return adapter.kind;
}

/** Whether email can actually be delivered. Read by the readiness endpoint. */
export function mailConfigured(): boolean {
  return adapter.kind !== "log";
}

// ---------------------------------------------------------------------------
// Message templates
//
// Deliberately plain. Every one of these is a security notification, and a
// security notification that looks like marketing gets ignored.
// ---------------------------------------------------------------------------

export function passwordResetEmail(link: string, expiresInMinutes: number): Omit<MailMessage, "to"> {
  return {
    subject: "Reset your Tiny CRM password",
    sensitive: true,
    text:
      `Someone asked to reset the password for this Tiny CRM account.\n\n` +
      `${link}\n\n` +
      `This link expires in ${expiresInMinutes} minutes and can be used once.\n\n` +
      `If this wasn't you, you can ignore this message — your password has not ` +
      `changed. If you get these repeatedly, someone may know your email address ` +
      `and be trying to get in.\n`,
    html:
      `<p>Someone asked to reset the password for this Tiny CRM account.</p>` +
      `<p><a href="${escapeHtml(link)}">Reset your password</a></p>` +
      `<p>This link expires in ${expiresInMinutes} minutes and can be used once.</p>` +
      `<p>If this wasn't you, you can ignore this message — your password has not changed.</p>`,
  };
}

export function verificationEmail(link: string, expiresInHours: number): Omit<MailMessage, "to"> {
  return {
    subject: "Confirm your email address",
    sensitive: true,
    text:
      `Confirm this email address to finish setting up Tiny CRM.\n\n` +
      `${link}\n\n` +
      `This link expires in ${expiresInHours} hours.\n\n` +
      `Until it is confirmed you can use your own workspace, but you cannot ` +
      `invite anyone, export data, or connect an integration.\n`,
    html:
      `<p>Confirm this email address to finish setting up Tiny CRM.</p>` +
      `<p><a href="${escapeHtml(link)}">Confirm my email address</a></p>` +
      `<p>This link expires in ${expiresInHours} hours.</p>`,
  };
}

/**
 * The one invitation email.
 *
 * Says who, which workspace and which role before the link, because the
 * question a person actually has on opening it is "is this real and do I want
 * it" — not "where do I click". The inviter's name is included on purpose: an
 * invitation from a stranger to a workspace you have never heard of should look
 * exactly as suspicious as it is.
 */
export function invitationEmail(options: {
  link: string;
  inviterName: string | null;
  workspaceName: string;
  roleLabel: string;
  expiresInDays: number;
}): Omit<MailMessage, "to"> {
  const who = options.inviterName?.trim() || "Someone";
  const headline = `${who} invited you to join ${options.workspaceName} on Tiny CRM`;
  return {
    subject: headline,
    sensitive: true,
    text:
      `${headline}.\n\n` +
      `Role: ${options.roleLabel}\n\n` +
      `${options.link}\n\n` +
      `This link expires in ${options.expiresInDays} days and can be used once.\n\n` +
      `If you were not expecting this, you can ignore it — nothing happens until ` +
      `you open the link and accept.\n`,
    html:
      `<p>${escapeHtml(headline)}.</p>` +
      `<p>Role: <strong>${escapeHtml(options.roleLabel)}</strong></p>` +
      `<p><a href="${escapeHtml(options.link)}">Join ${escapeHtml(options.workspaceName)}</a></p>` +
      `<p>This link expires in ${options.expiresInDays} days and can be used once.</p>` +
      `<p>If you were not expecting this, you can ignore it — nothing happens ` +
      `until you open the link and accept.</p>`,
  };
}

/**
 * Sent *after* a password changes, to the address that owns the account.
 *
 * The one email that matters most in an account takeover: it is how the real
 * owner finds out. It carries no link, so it is safe even if the attacker also
 * controls the inbox — there is nothing in it to use.
 */
export function passwordChangedEmail(when: Date): Omit<MailMessage, "to"> {
  const at = when.toISOString().replace("T", " ").slice(0, 16);
  return {
    subject: "Your Tiny CRM password was changed",
    text:
      `The password for your Tiny CRM account was changed at ${at} UTC.\n\n` +
      `Every other signed-in session was signed out.\n\n` +
      `If this wasn't you, reset your password immediately and check ` +
      `Settings → Security for sessions you don't recognise.\n`,
  };
}

export function newSignInEmail(device: string, when: Date): Omit<MailMessage, "to"> {
  const at = when.toISOString().replace("T", " ").slice(0, 16);
  return {
    subject: "New sign-in to Tiny CRM",
    text:
      `Your Tiny CRM account was signed in to from ${device} at ${at} UTC.\n\n` +
      `If this wasn't you, change your password and sign out other sessions ` +
      `from Settings → Security.\n`,
  };
}
