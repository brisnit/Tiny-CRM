import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * A layout that redirects to a route inside its own segment redirects to itself
 * forever. This happened: `(app)/layout.tsx` sent an account with no workspace
 * to `/welcome`, which lives in the same route group, so the layout ran again,
 * saw no workspace, and redirected again. A brand-new account could not get
 * past sign-up.
 *
 * It was invisible locally because the seeded demo account already has a
 * workspace and `onboardedAt` set, so no local run ever rendered /welcome. Only
 * a real sign-up against the deployed build reached it.
 *
 * These are structural assertions rather than a render test: an RSC layout
 * cannot be meaningfully invoked from node:test, and the property that matters
 * — "the layout never redirects into its own segment unguarded" — is visible in
 * the source.
 */
describe("route group layouts cannot redirect to themselves", () => {
  const layout = read("src/app/(app)/layout.tsx");

  test("every in-group redirect target is excluded from the shell", () => {
    // Targets this layout redirects to, e.g. redirect("/welcome").
    const targets = [...layout.matchAll(/redirect\(\s*["'](\/[^"']*)["']\s*\)/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, "expected the layout to contain at least one redirect");

    // Which of those paths are actually served by this same route group?
    const groupDir = resolve(ROOT, "src/app/(app)");
    const inGroup = new Set(
      readdirSync(groupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("("))
        .map((e) => `/${e.name}`),
    );

    for (const target of targets) {
      if (!inGroup.has(target)) continue; // e.g. /login, outside the group
      assert.match(
        layout,
        new RegExp(`WITHOUT_SHELL[\\s\\S]{0,200}${target.replace("/", "\\/")}`),
        `${target} is inside the (app) route group and this layout redirects to it, ` +
          `so it must appear in WITHOUT_SHELL or the redirect is infinite`,
      );
    }
  });

  test("the layout resolves the current path before deciding to redirect", () => {
    assert.match(layout, /x-pathname/, "the layout must read the forwarded pathname");
    assert.match(
      layout,
      /WITHOUT_SHELL\.has\(pathname\)[\s\S]{0,120}return/,
      "the exclusion must return before the workspace redirect is reached",
    );
  });

  test("the proxy forwards the pathname the layout depends on", () => {
    const proxy = read("src/proxy.ts");
    assert.match(
      proxy,
      /requestHeaders\.set\(\s*["']x-pathname["']/,
      "src/proxy.ts must set x-pathname on the request, or the layout cannot see it",
    );
  });

  test("the onboarding route is matched by the proxy", () => {
    // If /welcome were excluded from the matcher, x-pathname would be absent
    // and the loop would return.
    const proxy = read("src/proxy.ts");
    const matcher = /matcher:\s*\[([\s\S]*?)\]/.exec(proxy)?.[1] ?? "";
    assert.doesNotMatch(matcher, /welcome/, "/welcome must not be excluded from the proxy matcher");
  });
});

/**
 * The second loop, found by an external tester rather than by this file.
 *
 * The layout sends an account with no workspace to /welcome. /welcome only
 * steps aside once a workspace exists. "Skip setup" set `onboardedAt` and
 * created nothing, so the two guards disagreed permanently and every app route
 * bounced back to onboarding — reported as *"not working for me when I skipped
 * setup. Now its a blank screen."*
 *
 * The behaviour is covered by tests/integration/onboarding-zero-state.test.ts,
 * which is where the real assertion lives. These are the structural companions:
 * they fail fast if someone later "simplifies" the action back into the shape
 * that caused it, without needing a database to notice.
 */
describe("skipping setup cannot recreate the onboarding loop", () => {
  const onboarding = read("src/lib/actions/onboarding.ts");
  const layout = read("src/app/(app)/layout.tsx");
  const welcome = read("src/app/(app)/welcome/page.tsx");

  test("the layout still redirects an account with no workspace to /welcome", () => {
    // The premise of everything below. If this stops being true the loop is
    // gone, but so is the reason these tests are written this way.
    assert.match(
      layout,
      /workspaces\.length === 0\)\s*redirect\("\/welcome"\)/,
      "the layout no longer redirects on an empty workspace list — revisit these assertions",
    );
  });

  test("completing onboarding provisions a workspace, which is what breaks the loop", () => {
    assert.match(
      onboarding,
      /provisionWorkspace/,
      "completeOnboarding must create a workspace when the account has none, or " +
        "skipping setup leaves the layout redirecting to /welcome forever",
    );
    assert.match(
      onboarding,
      /memberships\.length === 0/,
      "the provisioning must be conditional on the account actually having no workspace",
    );
  });

  test("the guided flow can be reopened after it was skipped", () => {
    assert.match(
      welcome,
      /resume/,
      "skipping setup must not make the guided flow permanently unreachable",
    );
  });
});
