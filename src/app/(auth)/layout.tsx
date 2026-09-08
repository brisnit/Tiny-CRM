import Link from "next/link";

import { appOrigin } from "@/lib/origin";
import { LogoLockup } from "@/components/brand/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center">
          <LogoLockup />
        </Link>
        {children}
      </div>
      <p className="mt-10 text-center text-[12px] text-faint">
        <Link href="/" className="transition-colors hover:text-muted">
          {/*
            Was the literal "tinycrm.app" — a domain that does not resolve —
            shown on every sign-in, sign-up and password-reset page. The link
            itself was relative and correct, so the text quietly named the
            wrong product to anyone reading it while recovering their account.
            Derived from the canonical origin now, so it cannot drift again.
          */}
          Back to {new URL(appOrigin()).hostname}
        </Link>
      </p>
    </div>
  );
}
