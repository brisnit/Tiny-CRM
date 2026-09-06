import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { db } from "@/lib/db";
import { env } from "@/lib/env";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.authSecret,
  trustHost: true,
  // JWT sessions keep every page render free of a session table round-trip,
  // which matters because the app shell reads the session on every request.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: "/login", newUser: "/welcome", error: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const user = await db.user.findUnique({
          where: { email: parsed.data.email.toLowerCase().trim() },
          select: { id: true, email: true, name: true, avatarUrl: true, passwordHash: true, plan: true },
        });
        if (!user?.passwordHash) return null;

        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatarUrl,
          plan: user.plan,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user, trigger }) {
      if (user) {
        token.uid = user.id;
        token.plan = (user as { plan?: string }).plan ?? "free";
      }
      // `update()` from the client after an upgrade refreshes the cached plan
      // without forcing a sign-out.
      if (trigger === "update") token.refreshPlan = true;
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      session.user.plan = (token.plan as string) ?? "free";
      return session;
    },
  },
});
