"use client";

import { signOut } from "next-auth/react";

/**
 * A way out of onboarding.
 *
 * Sign out lives in the application shell, and onboarding does not render the
 * shell — so an account that had not finished setting up had no way to sign
 * out, no way back to the marketing site, and nothing to do if the screen
 * failed to render. That is an account trap, and it is exactly what happened
 * when /welcome went blank: the only screen the account could reach was the one
 * that was broken.
 *
 * This is not a substitute for the page rendering correctly. It is what makes
 * the next rendering failure recoverable instead of terminal.
 */
export function OnboardingEscape() {
  return (
    <footer className="pb-8 text-center text-[12px] text-faint">
      <button
        type="button"
        onClick={() => void signOut({ callbackUrl: "/" })}
        className="underline-offset-2 transition-colors hover:text-muted hover:underline"
      >
        Sign out
      </button>
      <span className="mx-2 opacity-40">·</span>
      {/*
        A real navigation, not <Link>. This is an escape hatch from a screen
        that may have failed to render, and the failure it exists for was the
        client router reconciling a redirect into an empty tree. Handing that
        same router the job of getting the user out would be trusting the thing
        that broke.
      */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="underline-offset-2 transition-colors hover:text-muted hover:underline">
        Back to tinycrm.biz
      </a>
    </footer>
  );
}
