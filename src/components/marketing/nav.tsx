"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#ai", label: "Tiny AI" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export function MarketingNav({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-colors duration-200",
        scrolled ? "border-b border-hairline bg-canvas/85 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" aria-label="Tiny CRM home">
          <Logo />
        </Link>

        <ul className="ml-2 hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-sunken hover:text-body"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <Button asChild variant="brand" size="sm">
              <Link href="/home">Open Tiny CRM</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild variant="brand" size="sm">
                <Link href="/signup">Start free</Link>
              </Button>
            </>
          )}
          <button
            className="rounded-lg p-2 text-muted hover:bg-sunken md:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label="Menu"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </nav>

      {open ? (
        <div className="border-t border-hairline bg-panel px-4 py-2 md:hidden">
          <ul className="space-y-0.5">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2 text-[13px] font-medium text-muted hover:bg-sunken hover:text-body"
                >
                  {link.label}
                </a>
              </li>
            ))}
            {!signedIn ? (
              <li>
                <Link
                  href="/login"
                  className="block rounded-lg px-3 py-2 text-[13px] font-medium text-muted hover:bg-sunken hover:text-body"
                >
                  Sign in
                </Link>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </header>
  );
}
