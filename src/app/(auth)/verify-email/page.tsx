import Link from "next/link";

import { ResendVerificationForm } from "@/components/app/auth-forms";
import { verifyEmail } from "@/lib/actions/auth";

export const metadata = { title: "Verify your email" };

/**
 * Redeems a verification token from the emailed link.
 *
 * The redemption happens on render rather than behind a button. That makes the
 * link itself the action, which is what users expect from a verification email —
 * and it is safe here because the token is single-use and scoped to one purpose:
 * `verifyEmail` refuses a password-reset token, and a second visit to the same
 * link finds it already spent.
 */
export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const result = token ? await verifyEmail(token) : null;

  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
      <div className="mb-5 text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">
          {result?.ok ? "Email verified" : "Verify your email"}
        </h1>
      </div>

      {result?.ok ? (
        <div className="space-y-4 text-[13px]">
          <p className="text-body">
            Thanks — your address is confirmed. Exports, invitations and
            integrations are now available.
          </p>
          <Link
            href="/home"
            className="block rounded-lg bg-brand-600 px-4 py-2.5 text-center text-[13px] font-medium text-white hover:bg-brand-700"
          >
            Continue to Tiny CRM
          </Link>
        </div>
      ) : (
        <div className="space-y-4 text-[13px] text-muted">
          <p>
            {token
              ? "That link is no longer valid. Verification links expire and can only be used once."
              : "Open the link from your verification email, or ask for a new one below."}
          </p>
          <ResendVerificationForm />
          <p className="text-center">
            <Link href="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
              Back to sign in
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
