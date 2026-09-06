import Link from "next/link";
import { redirect } from "next/navigation";
import { Check } from "lucide-react";

import { SignupForm } from "@/components/app/auth-forms";
import { getCurrentUser } from "@/lib/auth/session";
import { PLANS } from "@/lib/plans";

export const metadata = { title: "Create your account" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  if (await getCurrentUser()) redirect("/home");
  const params = await searchParams;
  const plan = typeof params.plan === "string" ? params.plan : "free";
  const selected = PLANS[plan as keyof typeof PLANS] ?? PLANS.free;

  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">
      <div className="mb-5 text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">Start with Tiny CRM</h1>
        <p className="mt-1 text-[13px] text-muted">
          Free forever for your first few clients. No card required.
        </p>
      </div>

      {selected.id !== "free" ? (
        <div className="mb-5 rounded-xl border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-900 dark:bg-brand-950/40">
          <p className="text-[13px] font-medium text-brand-800 dark:text-brand-300">
            {selected.name} selected
          </p>
          <p className="mt-0.5 text-[12px] text-muted">
            Create your account first — you can complete the upgrade from Settings.
          </p>
        </div>
      ) : null}

      <SignupForm plan={selected.id} />

      <ul className="mt-5 space-y-1.5 border-t border-hairline pt-4">
        {PLANS.free.features.slice(0, 4).map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-[12px] text-muted">
            <Check className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
            {feature}
          </li>
        ))}
      </ul>

      <p className="mt-5 text-center text-[13px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Sign in
        </Link>
      </p>
    </div>
  );
}
