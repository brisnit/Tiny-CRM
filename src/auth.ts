import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { db } from "@/lib/db";
import { env, isProduction } from "@/lib/env";
import { cookieName, cookieOptions } from "@/lib/auth/cookies";
import { PASSWORD_HASH_COST, needsRehash } from "@/lib/auth/password";
import { recordAudit } from "@/lib/audit";
import { log } from "@/lib/logger";
import { checkRateLimit, clientAddress, resetRateLimit } from "@/lib/rate-limit";

/**
 * Authentication.
 *
 * This file is the only place NextAuth appears. Business code talks to
 * `src/lib/auth/context.ts`, so replacing this with Clerk, WorkOS or Auth0 means
 * reimplementing `resolveSession()` there and rewriting this file — nothing in
 * the CRM changes.
 *
 * Hardening applied over the prototype:
 *  - bcrypt cost 12 (was the library default of 10), with transparent rehash
 *  - per-account lockout after repeated failures, plus a per-IP limiter
 *  - a dummy hash on unknown accounts, so a missing user is not measurably faster
 *  - deactivated accounts are refused even with correct credentials
 *  - cookies are Secure + HttpOnly + SameSite=Lax in production
 *  - every outcome is written to the audit log
 */

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

/**
 * A real bcrypt hash of a value nobody knows, used to spend the same time on an
 * unknown account as on a known one.
 */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO1Xk1Q9Q6nO0Z0z6Xr7pY0nJ8vJ5Wq7C";

const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.authSecret,
  trustHost: true,

  // JWT sessions, made revocable.
  //
  // The token carries a session id and an epoch. `getIdentity()` checks both on
  // every request: the id must match a live `UserSession` row, and the epoch
  // must not be behind the user's current one. That turns a self-contained token
  // into one that can be ended — individually, or everywhere at once — which is
  // what the previous hardening report identified as missing.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14, updateAge: 60 * 60 },

  // 14 days rather than 30, and the JWT is re-issued hourly so a plan or status
  // change propagates without forcing a sign-out.
  jwt: { maxAge: 60 * 60 * 24 * 14 },

  cookies: {
    sessionToken: {
      name: cookieName(isProduction),
      options: cookieOptions(isProduction),
    },
  },

  pages: { signIn: "/login", newUser: "/welcome", error: "/login" },

  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        // Per-account limiter, independent of the per-IP one applied at the
        // route level: distributed credential stuffing spreads across addresses
        // but still converges on one account.
        const accountLimit = await checkRateLimit("loginPerAccount", { account: email });
        if (!accountLimit.ok) {
          await recordAudit({
            action: "auth.sign_in_failed",
            summary: "Sign-in blocked by rate limit",
            metadata: { reason: "rate_limited" },
          });
          return null;
        }

        const user = await db.user.findUnique({
          where: { email },
          select: {
            id: true, email: true, name: true, avatarUrl: true, passwordHash: true,
            plan: true, deactivatedAt: true, failedLoginCount: true, lockedUntil: true,
          },
        });

        // Spend comparable time whether or not the account exists.
        if (!user?.passwordHash) {
          await bcrypt.compare(password, DUMMY_HASH);
          await recordAudit({
            action: "auth.sign_in_failed",
            summary: "Sign-in failed",
            metadata: { reason: "unknown_account" },
          });
          return null;
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
          await bcrypt.compare(password, DUMMY_HASH);
          await recordAudit({
            actorId: user.id,
            actorEmail: user.email,
            action: "auth.sign_in_failed",
            summary: "Sign-in refused: account temporarily locked",
            metadata: { reason: "locked", until: user.lockedUntil.toISOString() },
          });
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);

        if (!valid) {
          const failures = user.failedLoginCount + 1;
          const shouldLock = failures >= LOCKOUT_THRESHOLD;
          await db.user.update({
            where: { id: user.id },
            data: {
              failedLoginCount: failures,
              lockedUntil: shouldLock
                ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
                : null,
            },
          });
          await recordAudit({
            actorId: user.id,
            actorEmail: user.email,
            action: shouldLock ? "auth.locked_out" : "auth.sign_in_failed",
            summary: shouldLock
              ? `Account locked after ${failures} failed attempts`
              : "Sign-in failed: wrong password",
            metadata: { failures },
          });
          return null;
        }

        // A correct password on a disabled account still fails.
        if (user.deactivatedAt) {
          await recordAudit({
            actorId: user.id,
            actorEmail: user.email,
            action: "auth.sign_in_failed",
            summary: "Sign-in refused: account deactivated",
            metadata: { reason: "deactivated" },
          });
          return null;
        }

        // Success: clear failure state and upgrade the hash if policy moved on.
        await db.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: null,
            lastSeenAt: new Date(),
            ...(needsRehash(user.passwordHash)
              ? { passwordHash: await bcrypt.hash(password, PASSWORD_HASH_COST) }
              : {}),
          },
        });
        await resetRateLimit("loginPerAccount", { account: email });

        await recordAudit({
          actorId: user.id,
          actorEmail: user.email,
          action: "auth.signed_in",
          summary: "Signed in",
        });

        // A server-side session record, so this sign-in can later be listed and
        // revoked. The id goes into the token; only its hash is stored.
        const { createSession } = await import("@/lib/auth/sessions");
        // Metadata for the session list, so a user can recognise their own
        // devices. Best-effort: a missing request object must not fail sign-in.
        const requestHeaders = request?.headers;
        const session = await createSession(user.id, {
          ip: requestHeaders ? clientAddress(requestHeaders) : null,
          userAgent: requestHeaders?.get("user-agent") ?? null,
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatarUrl,
          plan: user.plan,
          sessionId: session.sessionId,
          epoch: session.epoch,
        };
      },
    }),
  ],

  callbacks: {
    jwt({ token, user, trigger }) {
      if (user) {
        token.uid = user.id;
        token.plan = (user as { plan?: string }).plan ?? "free";
        // Carried for the lifetime of the token and checked on every request.
        token.sid = (user as { sessionId?: string }).sessionId ?? null;
        token.epoch = (user as { epoch?: number }).epoch ?? 0;
      }
      if (trigger === "update") token.refreshPlan = true;
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      // The plan on the token is a UI hint only. Every entitlement check reads
      // the stored plan from the database, so a forged token cannot grant one.
      session.user.plan = (token.plan as string) ?? "free";

      // Surfaced for src/lib/auth/context.ts, which does the actual validation.
      // Nothing here is trusted; these are claims to be checked, not facts.
      const carrier = session as unknown as Record<string, unknown>;
      carrier.sessionId = (token.sid as string | null) ?? null;
      carrier.epoch = (token.epoch as number | null) ?? null;
      carrier.issuedAt = (token.iat as number | null) ?? null;
      return session;
    },
  },

  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      if (!token?.uid) return;

      // Revoke the row as well as clearing the cookie. Without this, a token
      // copied before signing out stays valid for its full lifetime — the
      // cookie is deleted from one browser, not from the internet.
      const sessionId = token.sid as string | null;
      if (sessionId) {
        const { hashSessionId } = await import("@/lib/auth/sessions");
        await db.userSession.updateMany({
          where: { tokenHash: hashSessionId(sessionId), revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: "signed_out" },
        });
      }

      await recordAudit({
        actorId: token.uid as string,
        action: "auth.signed_out",
        summary: "Signed out",
      });
    },
  },

  logger: {
    error(error) {
      log.error("auth error", { error: error.message });
    },
    warn(code) {
      log.warn("auth warning", { code });
    },
    debug() {
      // NextAuth debug output can contain tokens; never forwarded to our logs.
    },
  },
});
