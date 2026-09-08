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

  test("the password fields stay uncontrolled", () => {
    // A password manager writes straight to the DOM. Controlled state here
    // would race with it — the thing this form is being fixed for.
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(
      forms.indexOf("export function ResetPasswordForm"),
      forms.indexOf("export function ResendVerificationForm"),
    );
    const passwordInputs = [...reset.matchAll(/<Input[^>]*type="password"[\s\S]*?\/>/g)];
    assert.equal(passwordInputs.length, 2, "expected the new-password and confirm fields");
    for (const [input] of passwordInputs) {
      assert.doesNotMatch(input, /\svalue=/, `a password field became controlled: ${input.slice(0, 80)}`);
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
});
