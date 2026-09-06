"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { signUp } from "@/lib/actions/auth";

function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[12px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
      <AlertCircle className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirect: false,
    });

    if (result?.error) {
      setError("That email and password don't match an account.");
      setPending(false);
      return;
    }
    router.push("/home");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <ErrorNote>{error}</ErrorNote>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Sign in
      </Button>

      <DemoHint />
    </form>
  );
}

export function SignupForm({ plan }: { plan: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    const result = await signUp({
      name: String(form.get("name") ?? ""),
      email,
      password,
    });

    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }

    // Sign straight in — asking someone to log in immediately after signing up
    // is friction with no purpose.
    await signIn("credentials", { email, password, redirect: false });
    router.push(plan !== "free" ? `/welcome?plan=${plan}` : "/welcome");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <ErrorNote>{error}</ErrorNote>
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required placeholder="Alex Rivera" />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 8 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Create account
      </Button>
    </form>
  );
}

/** The demo credentials, so the seeded database is discoverable. */
function DemoHint() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function useDemo() {
    setPending(true);
    await signIn("credentials", {
      email: "owner@tinycrm.app",
      password: "tinycrm",
      redirect: false,
    });
    router.push("/home");
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-hairline bg-sunken/60 p-3 text-center">
      <p className="text-[12px] text-muted">Want to look around first?</p>
      <button
        type="button"
        onClick={useDemo}
        disabled={pending}
        className="mt-1 text-[12px] font-medium text-brand-600 hover:underline disabled:opacity-60 dark:text-brand-400"
      >
        {pending ? "Signing in…" : "Open the demo workspace"}
      </button>
    </div>
  );
}
