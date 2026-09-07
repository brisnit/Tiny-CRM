import Link from "next/link";

import { ForgotPasswordForm } from "@/components/app/auth-forms";

export const metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
      <div className="mb-5 text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">Reset your password</h1>
        <p className="mt-1 text-[13px] text-muted">
          We&apos;ll email you a link. It expires shortly and can be used once.
        </p>
      </div>

      <ForgotPasswordForm />

      <p className="mt-5 text-center text-[13px] text-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Sign in
        </Link>
      </p>
    </div>
  );
}
