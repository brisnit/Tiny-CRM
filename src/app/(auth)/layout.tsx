import Link from "next/link";

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
          Back to tinycrm.app
        </Link>
      </p>
    </div>
  );
}
