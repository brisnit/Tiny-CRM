import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { env } from "@/lib/env";

/**
 * Proves the error-reporting pipeline actually works, on demand.
 *
 * An error tracker fails silently by nature: an empty dashboard means "nothing
 * broke" and "reporting is broken" identically, and there is no way to tell
 * which without causing a real fault. Waiting for a genuine production error to
 * find out is the same as not knowing.
 *
 * So this throws one deliberately. The exception escapes the handler, Next
 * catches it and calls `onRequestError` in src/instrumentation.ts, which is the
 * same path a real unhandled fault takes — the point is to exercise the
 * production wiring, not to call `captureError` directly, which would prove
 * only that a function is importable.
 *
 * ---------------------------------------------------------------------------
 * Why this is safe to ship
 * ---------------------------------------------------------------------------
 *
 * It reads no database, touches no tenant data and holds no session. It is
 * POST-only, so a crawler, prefetch or address-bar visit cannot reach it. It
 * requires `CRON_SECRET` over a constant-time comparison — the same gate as the
 * job runner — because an open endpoint that manufactures error reports is a
 * free way to exhaust an error-tracking quota and bury real incidents.
 *
 * The caller supplies a correlation nonce so a specific triggered event can be
 * found in the tracker. It is constrained to short lowercase hex: whatever is
 * echoed into an error message is about to be sent to a third party, and a
 * free-text field here would be a way to write arbitrary content into that
 * stream through an application that otherwise refuses to.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NONCE = /^[0-9a-f]{1,16}$/;

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
  if (!env.cronSecret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!authorized(request)) {
    // Deliberately no detail: this endpoint is public-routable.
    return NextResponse.json(
      { ok: false },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const nonce = request.headers.get("x-diagnostic-nonce") ?? "";
  const label = NONCE.test(nonce) ? nonce : "unlabelled";

  // Deliberate. This is the whole endpoint.
  throw new Error(`observability pipeline verification ${label} (no customer data involved)`);
}
