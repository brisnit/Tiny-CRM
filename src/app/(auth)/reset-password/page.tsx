import Link from "next/link";

import { ResetPasswordForm } from "@/components/app/auth-forms";

export const metadata = { title: "Choose a new password" };

/**
 * The token arrives in the query string, from the emailed link.
 *
 * It is passed straight to the server action and never validated here: whether
 * it is real, expired or already spent is the server's decision, and every one
 * of those answers is deliberately the same message. Checking it in the page
 * would either duplicate that logic or leak the difference.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
      <div className="mb-5 text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">Choose a new password</h1>
        <p className="mt-1 text-[13px] text-muted">
          Setting it signs out every other device.
        </p>
      </div>

      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className="space-y-3 text-[13px] text-muted">
          <p>That link is missing its token. Reset links expire, and each one works once.</p>
          <p>
            <Link href="/forgot-password" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
              Request a new link
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
