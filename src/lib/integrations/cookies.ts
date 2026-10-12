import "server-only";

import type { NextResponse } from "next/server";

/**
 * The single-use cookie carrying the PKCE verifier between the two halves of
 * the handshake.
 *
 * ## Why a cookie and not the session or a database row
 *
 * The verifier must be available to the callback and to nothing else. A
 * database row would need a key, and the only key available in the callback is
 * the state — which is exactly the value an attacker replays. A cookie is
 * scoped to the browser that started the flow, which is the property wanted:
 * a replayed callback URL opened anywhere else arrives without it.
 *
 * ## Why it is deleted on every exit path
 *
 * Single use is what makes replay fail. `clearVerifierCookie` is called on the
 * success redirect *and* on every refusal, so a verifier never survives one
 * attempt — otherwise a callback could be replayed as long as the state was
 * still inside its ten-minute window.
 *
 * `httpOnly` so script cannot read it, `sameSite: "lax"` because the provider
 * sends the browser back by a top-level GET and `strict` would withhold it,
 * `secure` everywhere except localhost, where there is no TLS to be secure
 * about and setting it would silently drop the cookie.
 */
export const VERIFIER_COOKIE = "tc_oauth_verifier";

/** Ten minutes, the same window the signed state allows. */
const MAX_AGE_SECONDS = 10 * 60;

export function verifierCookieOptions(origin: string) {
  return {
    name: VERIFIER_COOKIE,
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: origin.startsWith("https://"),
    path: "/api/integrations",
    maxAge: MAX_AGE_SECONDS,
  };
}

export function clearVerifierCookie(response: NextResponse): void {
  response.cookies.set({
    name: VERIFIER_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/api/integrations",
    maxAge: 0,
  });
}
