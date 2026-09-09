"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { requestPasswordReset, resendVerification, resetPasswordAction, signUp } from "@/lib/actions/auth";
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
/**
 * A full navigation, deliberately, not `router.push()` + `router.refresh()`.
 *
 * Those two race. The push starts an RSC fetch for the destination; the refresh
 * invalidates the tree underneath it; and when the destination's layout answers
 * with a server `redirect()` — which it does for any account that has no
 * workspace yet — the two interleave and leave the router holding a shell with
 * no page in it. The result is a blank screen that never settles: 34KB of HTML
 * and nothing visible.
 *
 * Found by signing in as an account that had signed up and never finished
 * onboarding. The server was innocent throughout — a hard reload of the very
 * same URL rendered correctly, and so did fetching it directly.
 *
 * Crossing a session boundary is exactly where a full navigation is worth its
 * cost: the new cookie is guaranteed to be on the request, and any redirect the
 * layout wants to perform resolves server-side before anything renders.
 */
function goHard(href: string) {
  window.location.assign(href);
}

/**
 * `method="post"` on every form here is a security control, not a formality.
 *
 * These forms submit through `onSubmit`, which calls `preventDefault()`, so in
 * normal use the method attribute is never consulted. It matters in the two
 * cases where the handler is not attached: before React hydrates, and when the
 * script fails to load at all. A form with no method defaults to GET, and the
 * browser then puts every field in the query string.
 *
 * Reproduced against production with JavaScript disabled, on all five:
 *
 *   /login           ?email=...&password=...
 *   /signup          ?name=...&email=...&password=...
 *   /reset-password  ?password=...&confirm=...   — and the ?token= was replaced
 *   /forgot-password ?email=...
 *   /verify-email    ?email=...
 *
 * What that actually costs, measured rather than assumed: Vercel's runtime logs
 * record the path without the query, there is no analytics package, CSP blocks
 * third-party requests, and `Referrer-Policy: strict-origin-when-cross-origin`
 * keeps the URL out of cross-origin Referer headers. The exposure that remains
 * is the browser's own history — plaintext, on disk, in address-bar
 * autocomplete, and synced across devices when browser sync is on. That is
 * enough: a password does not belong in a URL.
 *
 * POST fails closed. Without JavaScript the browser posts to a route that does
 * not accept POST and the submit does not complete, which is the right outcome
 * — better a form that visibly does nothing than one that quietly writes a
 * password into history. Making these work without JavaScript is separate work
 * and needs server actions, not a method attribute.
 */
export function LoginForm({ demo = null }: { demo?: DemoCredentials | null }) {
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
    goHard("/home");
  }

  return (
    <form method="post" onSubmit={submit} className="space-y-3.5">
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
    goHard(plan !== "free" ? `/welcome?plan=${plan}` : "/welcome");
  }

  return (
    <form method="post" onSubmit={submit} className="space-y-3.5">
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
  const [pending, setPending] = React.useState(false);

  async function useDemo() {
    setPending(true);
    await signIn("credentials", { ...credentials, redirect: false });
    goHard("/home");
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
    <form method="post" onSubmit={submit} className="space-y-3.5">
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
  const [state, formAction, pending] = React.useActionState(resetPasswordAction, null);

  /**
   * Controlled, because React resets an uncontrolled form after a form action
   * completes — including when the action *failed*.
   *
   * That reset is what produced the loop. Chrome's "Use Strong Password" fills
   * and submits; if the two fields disagree at that moment the server answers
   * "those passwords do not match"; React then wiped both fields, so the person
   * was returned to an empty form with no way to correct anything. Repeating
   * the suggestion repeated the wipe.
   *
   * Holding the values in state survives the reset, so a mismatch now leaves
   * both fields exactly as they were with the message above them.
   *
   * The mount sync below is the other half. A password manager can fill before
   * React hydrates, and a value React never saw would be erased by the first
   * render. This reads whatever is already in the DOM and adopts it.
   */
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const confirmRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const filled = passwordRef.current?.value ?? "";
    const filledConfirm = confirmRef.current?.value ?? "";
    if (filled) setPassword((current) => current || filled);
    if (filledConfirm) setConfirm((current) => current || filledConfirm);
  }, []);

  /**
   * A form *action*, not an onSubmit handler.
   *
   * The previous version submitted through `onSubmit` and called
   * `preventDefault()`. Anything that submitted the form another way never ran
   * that handler, so the browser posted to the page, Next answered 200, and the
   * person landed back on a freshly rendered empty form with the token still in
   * the URL — able to repeat it forever without ever consuming the token.
   *
   * Chrome does exactly that after "Use Strong Password", which is why it then
   * offers to update the saved credential: from the browser's point of view the
   * password form *was* submitted. With a form action the submission is handled
   * wherever it originates — React, a password manager, or no JavaScript at all.
   *
   * The fields stay uncontrolled deliberately. A password manager writes
   * straight to the DOM, and the value it writes is what FormData reads; adding
   * controlled state here would create the very race this form is being fixed
   * for.
   */
  if (state?.ok) {
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
    <form action={formAction} className="space-y-3.5">
      <ErrorNote>{state && !state.ok ? state.error : null}</ErrorNote>
      {/* The token already travels in the URL; carrying it in the form is what
          lets a submission from any source complete the reset. */}
      <input type="hidden" name="token" value={token} />
      <Field label="New password" htmlFor="password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
        <Input
          ref={passwordRef}
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input
          ref={confirmRef}
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Set new password
      </Button>
    </form>
  );
}

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
    <form method="post" onSubmit={submit} className="space-y-3.5">
      <Field label="Email" htmlFor="resend-email">
        <Input id="resend-email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
      </Field>
      <Button type="submit" variant="outline" size="lg" className="w-full" loading={pending}>
        Send a new link
      </Button>
    </form>
  );
}
