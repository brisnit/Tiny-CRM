import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
describe("onboarding is not inside the shell-bearing route group", () => {
  const appLayout = read("src/app/(app)/layout.tsx");

  /**
   * The original bug: `(app)/layout.tsx` sent an account with no workspace to
   * /welcome, which lived in the same route group, so the layout ran again, saw
   * no workspace, and redirected forever.
   *
   * The first fix kept /welcome in the group and had the layout read the
   * `x-pathname` header, returning bare children for that one path. That traded
   * the loop for something subtler: one layout rendering two structurally
   * different trees depending on a request header. The client router cannot
   * follow that — a navigation to /home that server-redirects to /welcome was
   * reconciled against the layout already in hand and produced an empty tree.
   * A blank white page, on the only screen such an account can reach, while a
   * hard load of the identical URL rendered correctly.
   *
   * Separate route groups mean separate layouts, so the redirect crosses a
   * boundary and the router rebuilds instead of reconciling. These assert that
   * separation rather than the mechanism that replaced it.
   */

  test("/welcome is not in the (app) route group", () => {
    assert.ok(
      !existsSync(resolve(ROOT, "src/app/(app)/welcome/page.tsx")),
      "/welcome is back inside the shell-bearing group, where the layout redirects to it",
    );
    assert.ok(
      existsSync(resolve(ROOT, "src/app/(onboarding)/welcome/page.tsx")),
      "/welcome is missing from the onboarding route group",
    );
  });

  test("the onboarding group has its own layout", () => {
    assert.ok(
      existsSync(resolve(ROOT, "src/app/(onboarding)/layout.tsx")),
      "without its own layout the onboarding group inherits the root one and loses its auth check",
    );
    const layout = read("src/app/(onboarding)/layout.tsx");
    assert.match(layout, /getActor|requireActor/, "the onboarding layout does not check authentication");
    assert.match(layout, /redirect\("\/login"\)/, "an unauthenticated visitor is not sent to sign in");
  });

  test("the app layout does not branch on a request header", () => {
    // The specific shape that broke the client router.
    // Code only. The comment above the layout explains why the header is gone,
    // and matching that would make this test fail on its own explanation.
    const code = appLayout
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(
      code,
      /x-pathname/,
      "the app layout is reading x-pathname again, which makes its tree shape depend on the request",
    );
    assert.doesNotMatch(code, /WITHOUT_SHELL/, "the conditional-shell exclusion is back");
  });

  test("the app layout still redirects an account with no workspace", () => {
    // The premise. If this changes, the tests above are guarding nothing.
    assert.match(
      appLayout,
      /workspaces\.length === 0\)\s*redirect\("\/welcome"\)/,
      "the app layout no longer redirects on an empty workspace list — revisit these assertions",
    );
  });

  test("the app layout redirects out of its own route group", () => {
    // What makes the redirect safe: /welcome is now a different group, so this
    // cannot loop back into the layout that issued it.
    assert.ok(
      !existsSync(resolve(ROOT, "src/app/(app)/welcome")),
      "the redirect target is inside the redirecting layout's own group",
    );
  });

  test("onboarding offers a way out", () => {
    // Sign out lives in the app shell, which onboarding does not render. An
    // account that cannot finish setup had no way to sign out and nothing to do
    // if the screen failed — which is precisely what happened.
    const escape = read("src/components/app/onboarding-escape.tsx");
    assert.match(escape, /signOut/, "onboarding has no sign-out, so a rendering failure is an account trap");
    const layout = read("src/app/(onboarding)/layout.tsx");
    assert.match(layout, /OnboardingEscape/, "the onboarding layout does not render the escape hatch");
  });
});


describe("skipping setup cannot recreate the onboarding loop", () => {
  const onboarding = read("src/lib/actions/onboarding.ts");
  const layout = read("src/app/(app)/layout.tsx");
  const welcome = read("src/app/(onboarding)/welcome/page.tsx");

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
