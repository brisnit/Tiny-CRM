import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { mailAdapterKind, sendMail } from "@/lib/mail";

/**
 * Proves the production mail path actually delivers, on demand.
 *
 * Transactional mail fails silently by nature. A provider that refuses every
 * message produces the same observable state as one nobody has used: an empty
 * inbox. Production ran for weeks with `MAIL_PROVIDER_URL` and
 * `MAIL_PROVIDER_TOKEN` set and no `MAIL_FROM`, sending everything from
 * `no-reply@localhost` and having every message refused, and the only way that
 * surfaced was somebody reading the configuration. Waiting for a customer to
 * report a password reset that never arrived is the same as not knowing.
 *
 * So this sends exactly one message, through `sendMail` — the same function
 * password reset, email verification and invitations use — so what is
 * exercised is the production wiring rather than a function being importable.
 *
 * ---------------------------------------------------------------------------
 * Why this is safe to ship
 * ---------------------------------------------------------------------------
 *
 * **The recipient is fixed in code.** It is not a parameter, not a header and
 * not a body field. An authenticated "send mail to an address of your
 * choosing" endpoint is an open relay the moment the secret leaks, and a
 * secret in an environment variable is not a secret you can promise never
 * leaks. The address below is our own published privacy contact, already on
 * the privacy page, and it is the only address this endpoint can ever reach.
 *
 * **The body is fixed in code too**, for the same reason the sibling error
 * endpoint constrains its nonce: whatever a caller can write into an outgoing
 * message is content this application will send on their behalf.
 *
 * It reads no database, touches no tenant data and holds no session. It is
 * POST-only, so a crawler, prefetch or address-bar visit cannot reach it. It
 * requires `CRON_SECRET` over a constant-time comparison — the same gate as
 * the job runner and the error endpoint.
 *
 * It refuses when the real provider is not selected, because a success
 * against the development sink would prove nothing while looking exactly like
 * proof.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The only address this endpoint can send to. Not caller-supplied. */
const RECIPIENT = "privacy@tinycrm.biz";

function authorized(request: Request): boolean {
  const secret = env.cronSecret;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length === 0) return false;

  // Constant-time, and length-safe: timingSafeEqual throws on a length
  // mismatch, which would itself leak the secret's length.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  const noStore = { "cache-control": "no-store" };

  if (!env.cronSecret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured" },
      { status: 503, headers: noStore },
    );
  }

  if (!authorized(request)) {
    // Deliberately no detail: this endpoint is public-routable.
    return NextResponse.json({ ok: false }, { status: 401, headers: noStore });
  }

  const adapter = mailAdapterKind();
  if (adapter !== "http") {
    return NextResponse.json(
      {
        ok: false,
        adapter,
        error:
          "The real mail provider is not selected, so a send here would prove nothing. " +
          "Set MAIL_PROVIDER_URL and MAIL_PROVIDER_TOKEN.",
      },
      { status: 503, headers: noStore },
    );
  }

  const result = await sendMail({
    to: RECIPIENT,
    subject: "Tiny CRM mail configuration test",
    text:
      "This message confirms that Tiny CRM's production mail configuration can " +
      "deliver.\n\n" +
      "It was sent deliberately from /api/diagnostics/mail and contains no " +
      "customer data. Nothing needs to be done with it.\n\n" +
      `Sender: ${env.mailFrom}\n` +
      `Sent: ${new Date().toISOString()}\n`,
  });

  // The sender is echoed because it is the value under test and the one most
  // likely to be wrong. It is ours and appears on every message we send.
  return NextResponse.json(
    {
      ok: result.delivered,
      adapter: result.adapter,
      from: env.mailFrom,
      to: RECIPIENT,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
    },
    { status: result.delivered ? 200 : 502, headers: noStore },
  );
}
