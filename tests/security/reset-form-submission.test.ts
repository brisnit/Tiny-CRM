import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

import { db } from "../helpers/fixtures";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * A password reset has to complete however the form was submitted.
 *
 * The form's only working path was React's `onSubmit`, which called
 * `preventDefault()`. Anything submitting it another way never ran that
 * handler, so the browser posted to the page itself; Next answers a POST to a
 * page route with 200 and renders it again, so the person landed back on a
 * freshly rendered **empty** form with the token still in the URL and could
 * repeat it forever.
 *
 * Chrome does exactly that after "Use Strong Password" — which is why it then
 * offers "Update password?": from the browser's side the form *was* submitted.
 *
 * What was ruled out first, by simulating a password-manager fill in Chromium:
 * React clobbering the value. The inputs are uncontrolled and the filled value
 * survived a re-render intact. The failure was the submission path, not state.
 *
 * These cover the token semantics that make the loop survivable and the fix
 * correct. The browser half — that a real password manager can drive it — is
 * not something a server test can prove, and is not claimed here.
 */

const created: string[] = [];

async function account() {
  const id = `c${randomUUID().replace(/-/g, "")}`;
  await db.user.create({
    data: {
      id,
      email: `reset-form-${id}@test.local`,
      name: "Reset Probe",
      passwordHash: await bcrypt.hash("the-original-password", 4),
      emailVerifiedAt: new Date(),
    },
  });
  created.push(id);
  return id;
}

describe("a reset completes regardless of how the form was submitted", () => {
  after(async () => {
    await db.authToken.deleteMany({ where: { userId: { in: created } } });
    await db.user.deleteMany({ where: { id: { in: created } } });
    await db.$disconnect();
  });

  test("the form submits through a form action, not only onSubmit", () => {
    // The structural heart of the fix. An onSubmit-only form silently discards
    // any submission a password manager initiates.
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(forms.indexOf("export function ResetPasswordForm"));
    const formTag = /<form[^>]*>/.exec(reset)?.[0] ?? "";
    assert.match(formTag, /action=\{formAction\}/, "the reset form no longer uses a form action");
    assert.doesNotMatch(
      formTag,
      /onSubmit=/,
      "the reset form is back on onSubmit, which a password-manager submission bypasses",
    );
  });

  test("the token travels with the form so any submission can complete it", () => {
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(forms.indexOf("export function ResetPasswordForm"));
    assert.match(
      reset,
      /type="hidden"\s+name="token"/,
      "without the token in the form, a non-React submission cannot finish the reset",
    );
  });

  test("the password fields are controlled, with onChange", () => {
    // This assertion is the reverse of what it said first, and the reversal is
    // the point.
    //
    // The original theory was that controlled state races a password manager,
    // so the fields were left uncontrolled. Testing in Chromium disproved it: a
    // simulated fill survived a re-render intact, and the real mechanism turned
    // out to be React resetting an uncontrolled form after a form action — so a
    // failed action wiped both fields and produced the loop.
    //
    // Controlled values survive that reset. Autofill still works because Chrome
    // dispatches an input event, which onChange receives; a fill that lands
    // before hydration is adopted by the mount sync asserted below.
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(
      forms.indexOf("export function ResetPasswordForm"),
      forms.indexOf("export function ResendVerificationForm"),
    );
    const inputs = [...reset.matchAll(/<Input[\s\S]*?\/>/g)].map(([m]) => m).filter((m) => /type="password"/.test(m));
    assert.equal(inputs.length, 2, "expected the new-password and confirm fields");
    for (const input of inputs) {
      assert.match(input, /value=\{/, `a password field is uncontrolled, so a failed action clears it: ${input.slice(0, 60)}`);
      assert.match(input, /onChange=\{/, "a controlled password field without onChange cannot receive an autofill");
    }
  });

  test("password-manager metadata is correct on every auth form", () => {
    const forms = read("src/components/app/auth-forms.tsx");
    // A password manager needs a stable name, a stable id and the right
    // autocomplete token to offer generation and to save afterwards.
    for (const [label, needle] of [
      ["sign-in password", /id="password"\s+name="password"\s+type="password"\s+autoComplete="current-password"/],
      ["new password", /id="password"[\s\S]{0,120}autoComplete="new-password"/],
      ["confirm password", /id="confirm"[\s\S]{0,120}autoComplete="new-password"/],
      ["email", /id="email"\s+name="email"\s+type="email"\s+autoComplete="email"/],
    ] as const) {
      assert.match(forms, needle, `${label} is missing password-manager metadata`);
    }
  });

  test("merely rendering the page does not consume the token", () => {
    // The loop was survivable only because of this: every failed round trip
    // left the token intact. If opening the page spent it, the first bounce
    // would have locked the person out permanently.
    const page = read("src/app/(auth)/reset-password/page.tsx");
    assert.doesNotMatch(page, /redeemToken|resetPassword\(/, "the reset page consumes the token on render");
  });

  test("a successful reset consumes the token, and reuse is refused", async () => {
    const userId = await account();
    const { issueToken } = await import("../../src/lib/auth/tokens");
    const { resetPasswordAction } = await import("../../src/lib/actions/auth");

    const { token } = await issueToken(userId, "password_reset", {});

    const form = new FormData();
    form.set("token", token);
    form.set("password", "a-brand-new-password-1");
    form.set("confirm", "a-brand-new-password-1");
    const first = await resetPasswordAction(null, form);
    assert.equal(first.ok, true, `the reset did not complete: ${JSON.stringify(first)}`);

    const row = await db.authToken.findFirst({ where: { userId }, select: { usedAt: true } });
    assert.ok(row?.usedAt, "a completed reset left the token unspent");

    // The same token again must be refused.
    const again = new FormData();
    again.set("token", token);
    again.set("password", "yet-another-password-2");
    again.set("confirm", "yet-another-password-2");
    const second = await resetPasswordAction(null, again);
    assert.equal(second.ok, false, "a spent reset token was accepted a second time");
  });

  test("a mismatch is refused without spending the token", async () => {
    // The user can try again — which is the whole point of not consuming a
    // token on anything short of success.
    const userId = await account();
    const { issueToken } = await import("../../src/lib/auth/tokens");
    const { resetPasswordAction } = await import("../../src/lib/actions/auth");
    const { token } = await issueToken(userId, "password_reset", {});

    const form = new FormData();
    form.set("token", token);
    form.set("password", "one-password-here-11");
    form.set("confirm", "a-different-password-22");
    const result = await resetPasswordAction(null, form);
    assert.equal(result.ok, false);

    const row = await db.authToken.findFirst({ where: { userId }, select: { usedAt: true } });
    assert.equal(row?.usedAt, null, "a mismatched attempt spent the token");
  });

  test("a value arriving only in FormData still completes the reset", async () => {
    // What a password manager produces: a value written to the DOM that never
    // passed through React state. FormData is what the action receives either
    // way, so this is that path.
    const userId = await account();
    const { issueToken } = await import("../../src/lib/auth/tokens");
    const { resetPasswordAction } = await import("../../src/lib/actions/auth");
    const { token } = await issueToken(userId, "password_reset", {});

    const generated = "Xk7$mQ2vLp9wRt4z";
    const form = new FormData();
    form.set("token", token);
    form.set("password", generated);
    form.set("confirm", generated);
    const result = await resetPasswordAction(null, form);
    assert.equal(result.ok, true, `a generated-style password was refused: ${JSON.stringify(result)}`);

    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    const hash = user.passwordHash;
    assert.ok(hash, "the account lost its password hash");
    assert.ok(await bcrypt.compare(generated, hash), "the new password was not the one submitted");
    assert.ok(!hash.includes(generated), "the password is stored in readable form");
  });

  test("a failed action cannot clear the password fields", () => {
    // The loop's real mechanism. React resets an uncontrolled form after a form
    // action completes — including when it failed — so a "passwords do not
    // match" answer wiped both fields and returned the person to an empty form
    // with nothing to correct. Chrome's strong-password flow hits that answer,
    // which is why repeating the suggestion repeated the wipe.
    //
    // Controlled values survive the reset. Reproduced against production before
    // the fix: both fields went from filled to empty on a mismatch.
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(
      forms.indexOf("export function ResetPasswordForm"),
      forms.indexOf("export function ResendVerificationForm"),
    );
    for (const field of ["password", "confirm"]) {
      const input = new RegExp(`id="${field}"[\\s\\S]{0,320}?/>`, "m").exec(reset)?.[0] ?? "";
      assert.match(input, /value=\{/, `the ${field} field is uncontrolled, so a failed action clears it`);
      assert.match(input, /onChange=\{/, `the ${field} field has no onChange, so a password manager's fill is lost`);
    }
  });

  test("a value filled before hydration is adopted rather than erased", () => {
    // A password manager can fill before React hydrates. Without this, the
    // first render would replace a value React never saw with an empty string.
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(forms.indexOf("export function ResetPasswordForm"));
    assert.match(reset, /useEffect\(/, "nothing adopts a pre-hydration autofill");
    assert.match(reset, /passwordRef|confirmRef/, "the fields are not reachable to read what the browser filled");
  });

  test("crossing the session boundary uses a full navigation", () => {
    // Separate bug, same screen. router.push() + router.refresh() race: the
    // push fetches the destination, the refresh invalidates underneath it, and
    // when the layout answers with a server redirect the two interleave and
    // leave a shell with no page in it — a blank screen that never settles.
    //
    // Verified against production: the client-side path was blank while a hard
    // reload of the identical URL rendered correctly.
    for (const file of ["src/components/app/auth-forms.tsx", "src/components/app/onboarding.tsx"]) {
      const source = read(file);
      const racing = source.split("\n").filter((line, i, all) =>
        /router\.push\(/.test(line) && /router\.refresh\(\)/.test(all[i + 1] ?? ""));
      assert.equal(
        racing.length,
        0,
        `${file} still pairs router.push with router.refresh, which blanks the screen on a redirect`,
      );
    }
  });
});
