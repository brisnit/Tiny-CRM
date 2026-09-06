import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/app/auth-forms";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/home");

  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
      <div className="mb-5 text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">Welcome back</h1>
        <p className="mt-1 text-[13px] text-muted">Sign in to your workspaces.</p>
      </div>

      <LoginForm />

      <p className="mt-5 text-center text-[13px] text-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Create an account
        </Link>
      </p>
    </div>
  );
}
