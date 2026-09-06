import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      plan: string;
    };
  }

  interface User {
    plan?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    plan?: string;
    refreshPlan?: boolean;
  }
}
