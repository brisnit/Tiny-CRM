import { NextResponse, type NextRequest } from "next/server";

import { cookieName } from "@/lib/auth/cookies";
import { contentSecurityPolicy } from "@/lib/csp";

/**
 * Edge redirect for signed-out visitors.
 *
 * **This is not an authorization control.** It only checks whether a session
 * cookie is *present*, never whether it is valid — that would require verifying
 * a JWT at the edge, and a forged cookie would sail past a presence check
 * anyway. Authorization happens in `requireActor()` / `requireWorkspaceAccess()`
 * on the server, on every page and every action, and is unaffected by anything
 * here.
 *
 * What this fixes is a real defect with a small blast radius: without it, an
 * unauthenticated request to a protected route reached the layout, threw
 * `unauthorized`, and rendered a 500 error page instead of the sign-in screen.
 * A 500 is the wrong answer, tells the visitor nothing, and buries a routine
 * event in the error logs.
 */

/** Route prefixes that require a session. Everything else is public. */
const PROTECTED = [
  "/home", "/projects", "/contacts", "/companies", "/deals", "/opportunities",
  "/tasks", "/calendar", "/notes", "/files", "/analytics", "/automations",
  "/ai", "/settings", "/welcome",
];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // A fresh nonce per response. See src/lib/csp.ts for why this is here rather
  // than a static header in next.config.ts: Next emits inline bootstrap scripts
  // that a static `script-src 'self'` blocks outright, which breaks hydration.
  const nonce = Buffer.from(globalThis.crypto.randomUUID()).toString("base64");

  const policy = contentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next extracts the nonce by parsing the CSP on the *request*, and stamps it
  // onto every script it renders. Setting it only on the response is not
  // enough — the scripts are generated before the response header exists.
  requestHeaders.set("Content-Security-Policy", policy);

  const withCsp = (response: NextResponse) => {
    response.headers.set("Content-Security-Policy", policy);
    return response;
  };

  const isProtected = PROTECTED.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  // Either cookie name may be present depending on how the app is served; the
  // secure-prefixed one is what production sets.
  const hasSession =
    request.cookies.has(cookieName(true)) || request.cookies.has(cookieName(false));
  if (hasSession) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const login = new URL("/login", request.url);
  // Round-trip the destination so the user lands where they were going. Only a
  // same-origin path is carried, never a full URL, so this cannot be turned
  // into an open redirect.
  if (pathname !== "/home") login.searchParams.set("next", `${pathname}${search}`);
  return withCsp(NextResponse.redirect(login));
}

export const config = {
  matcher: [
    // Everything except Next internals, the API surface (which answers with
    // JSON status codes rather than redirects) and static files.
    "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt|xml)$).*)",
  ],
};
