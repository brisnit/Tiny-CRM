"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { requestPasswordReset, resendVerification, resetPassword, signUp } from "@/lib/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";

function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[12px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
      <AlertCircle className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export type DemoCredentials = { email: string; password: string };

/**
 * `demo` is resolved on the server and passed in — never read from a
 * `NEXT_PUBLIC_` variable, and never written as a literal in this file.
 *
 * A literal here would be compiled into the JavaScript bundle and readable by
 * anyone who opens devtools, whether or not the component that uses it ever
 * renders. Passing `null` from the server is what keeps the strings out of a
 * production build entirely, rather than merely keeping the button hidden.
 */
export function LoginForm({ demo = null }: { demo?: DemoCredentials | null }) {
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
      <div className="-mt-1 text-right">
        <a
          href="/forgot-password"
          className="text-[12px] font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Forgot password?
        </a>
      </div>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Sign in
      </Button>

      {demo ? <DemoHint credentials={demo} /> : null}
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
      <Field
        label="Password"
        htmlFor="password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={72}
        />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Create account
      </Button>
    </form>
  );
}

/**
 * One-click sign-in to the seeded demo workspace.
 *
 * Rendered only when the server passed credentials, which it does only when
 * `ALLOW_DEMO_AUTH` is on — and the production startup gate refuses to boot with
 * that flag set. Two independent guards, because either alone is one edit away
 * from shipping a working login to everyone.
 */
function DemoHint({ credentials }: { credentials: DemoCredentials }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function useDemo() {
    setPending(true);
    await signIn("credentials", { ...credentials, redirect: false });
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

/**
 * Requests a password reset.
 *
 * The server answers identically whether or not the address has an account, so
 * this shows the same confirmation either way. Reflecting anything else — even
 * a different phrasing, even a different delay — would turn the form into an
 * account-existence oracle, which is the thing the server action is careful to
 * avoid.
 */
export function ForgotPasswordForm() {
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    await requestPasswordReset({ email: String(form.get("email") ?? "") });
    setPending(false);
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-3 text-[13px] text-muted">
        <p className="text-body">
          If that address has an account, a reset link is on its way. It expires
          shortly, and using it signs out every other device.
        </p>
        <p>
          Nothing arrived? Check spam, then{" "}
          <button type="button" className="font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => setSent(false)}>
            try again
          </button>
          .
        </p>
        <p className="pt-1">
          <a href="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Back to sign in
          </a>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Send reset link
      </Button>
      <p className="text-center text-[13px] text-muted">
        <a href="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Back to sign in
        </a>
      </p>
    </form>
  );
}

/** Completes a password reset with the token from the emailed link. */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password !== confirm) {
      setError("Those passwords do not match.");
      setPending(false);
      return;
    }

    const result = await resetPassword({ token, password });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    setDone(true);
    setPending(false);
  }

  if (done) {
    return (
      <div className="space-y-3 text-[13px]">
        <p className="text-body">
          Your password is changed, and every other session has been signed out.
        </p>
        <Button variant="brand" size="lg" className="w-full" onClick={() => router.push("/login")}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <ErrorNote>{error}</ErrorNote>
      <Field label="New password" htmlFor="password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Set new password
      </Button>
    </form>
  );
}

/** Asks for another verification link. Same anti-enumeration rule as above. */
export function ResendVerificationForm() {
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    await resendVerification({ email: String(form.get("email") ?? "") });
    setPending(false);
    setSent(true);
  }

  if (sent) {
    return (
      <p className="text-[13px] text-body">
        If that address needs verifying, a new link is on its way.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <Field label="Email" htmlFor="resend-email">
        <Input id="resend-email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
      </Field>
      <Button type="submit" variant="outline" size="lg" className="w-full" loading={pending}>
        Send a new link
      </Button>
    </form>
  );
}
