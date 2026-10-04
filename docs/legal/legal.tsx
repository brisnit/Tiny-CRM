import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { LogoMark } from "@/components/brand/logo";

/**
 * Shell for the legal pages.
 *
 * Deliberately plain. These pages are read when somebody is deciding whether to
 * trust the product with their clients' details, or when a payment processor is
 * checking that the links it requires actually resolve — neither is helped by
 * marketing styling.
 *
 * `NeedsDetail` is the mechanism that keeps these honest: anything the codebase
 * cannot establish — a legal entity, an address, a governing jurisdiction — is
 * rendered as a visible gap rather than filled with a plausible guess. A privacy
 * notice naming the wrong entity is worse than one that is obviously incomplete,
 * because the first looks finished.
 */

export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark className="size-5" />
            <span className="text-[13px] font-medium text-body">Tiny CRM</span>
          </Link>
          <nav className="flex items-center gap-4 text-[12px] text-faint">
            <Link href="/privacy" className="transition-colors hover:text-muted">Privacy</Link>
            <Link href="/terms" className="transition-colors hover:text-muted">Terms</Link>
            <Link href="/" className="transition-colors hover:text-muted">Home</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.03em] text-body">{title}</h1>
        <p className="mt-2 text-[12.5px] text-faint">Last updated {updated}</p>
        <div className="mt-6 text-[14px] leading-relaxed text-muted">{intro}</div>
        <div className="mt-10 space-y-10">{children}</div>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-8 sm:px-6">
          <span className="text-[12px] text-faint">Tiny CRM</span>
          <div className="flex items-center gap-4 text-[12px] text-faint">
            <Link href="/privacy" className="transition-colors hover:text-muted">Privacy</Link>
            <Link href="/terms" className="transition-colors hover:text-muted">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function Section({ id, heading, children }: { id: string; heading: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-body">{heading}</h2>
      <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/**
 * A detail that must come from the business, not from the code.
 *
 * Rendered visibly rather than hidden in a comment, so an incomplete page cannot
 * be mistaken for a finished one — including by whoever publishes it.
 */
export function NeedsDetail({ children }: { children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex items-baseline gap-1 rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[12.5px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
      <AlertTriangle className="size-3 translate-y-px" aria-hidden />
      {children}
    </span>
  );
}

/** Banner stating that the page is not yet publishable. */
export function DraftBanner() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-400 bg-amber-50/80 p-4 text-[13px] leading-relaxed text-body dark:border-amber-800 dark:bg-amber-950/40">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div>
        <strong className="font-semibold">Draft — not yet legally reviewed.</strong> Every statement
        about how the software behaves was written from the code and is accurate. Everything
        highlighted in amber is a business or legal detail the codebase cannot supply, and has been
        left blank rather than guessed. This page should not be published, and must not be used to
        satisfy a payment processor&apos;s requirements, until those are filled in and a lawyer has
        reviewed the result.
      </div>
    </div>
  );
}
