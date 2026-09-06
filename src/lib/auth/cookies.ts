/**
 * Session cookie configuration.
 *
 * Extracted from the NextAuth setup so the flags can be asserted directly by a
 * test. A missing `secure` or `httpOnly` is a one-word mistake with a total
 * impact, and it is not the kind of thing an end-to-end test notices.
 *
 * No imports, so this can be read from a test without pulling in the auth stack.
 */

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
};

/**
 * `__Secure-` is a browser-enforced prefix: a cookie with that name is rejected
 * outright unless it is set over HTTPS with the Secure attribute. It makes the
 * production configuration verifiable by the client, not just by us.
 */
export function cookieName(production: boolean): string {
  return production ? "__Secure-authjs.session-token" : "authjs.session-token";
}

export function cookieOptions(production: boolean): SessionCookieOptions {
  return {
    // Never readable from JavaScript, so an XSS bug cannot exfiltrate a session.
    httpOnly: true,
    // Lax rather than Strict: Strict breaks the sign-in redirect and every
    // inbound link into the app, and CSRF is handled by Auth.js's own token.
    sameSite: "lax",
    path: "/",
    // Off in development only, because localhost is served over HTTP.
    secure: production,
  };
}
