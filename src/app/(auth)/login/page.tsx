import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/app/auth-forms";
import { getIdentity } from "@/lib/auth/context";
import { env } from "@/lib/env";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getIdentity()) redirect("/home");

  // Only ever a path inside this application — `safeNext` in the form discards
  // anything else, so the sign-in page cannot be turned into an open redirect.
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : null;

  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
      <div className="mb-5 text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">Welcome back</h1>
        <p className="mt-1 text-[13px] text-muted">Sign in to your workspaces.</p>
      </div>

      {/* Resolved here, on the server. Passing null in production is what keeps
          the demo credentials out of the client bundle entirely, rather than
          merely hiding the button that uses them. */}
      <LoginForm
        next={next}
        demo={
          env.allowDemoAuth ? { email: env.demoEmail, password: env.demoPassword } : null
        }
      />

      <p className="mt-5 text-center text-[13px] text-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Create an account
        </Link>
      </p>
    </div>
  );
}
