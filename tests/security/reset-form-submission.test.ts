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
 * The fix for that produced a second regression, and then a third, which is
 * why the shape of this form is now pinned from two directions. React resets an
 * uncontrolled form after a completed action, so a failed one wiped the fields;
 * making the fields controlled fixed that and introduced the worse bug, because
 * React's input reconciliation compares its prop against the live DOM value and
 * overwrote a password manager's write with empty state.
 *
 * An earlier run reported that the clobber "did not reproduce". It was wrong:
 * it forced re-renders with blur and resize events, which do not re-render a
 * component whose state has not changed, so it never exercised the path. The
 * behavioural half of this now lives in tests/browser/password-reset.test.ts,
 * where a real Chromium fills the field the way a password manager does. What
 * is left here is the token semantics that make the loop survivable, and the
 * structural properties that the browser suite would only catch after the fact.
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

  test("the password field is uncontrolled, and there is only one of it", () => {
    // Both halves are load-bearing, and this assertion has now been written in
    // both directions, so the reasoning is recorded rather than the verdict.
    //
    // Uncontrolled, because Chrome's generated-password flow writes to the DOM
    // without dispatching an event React can see. Any state mirroring this
    // field stays empty, and React's reconciliation writes that empty value
    // back over the browser's — reproduced in Chromium, and the reason the
    // field emptied itself mid-submit.
    //
    // One field, because the confirm field is what made state look necessary:
    // its mismatch answer was the only failure worth preserving values across.
    // Without it the remaining failures are a password below the minimum and a
    // dead token, and neither wants the old value back.
    const forms = read("src/components/app/auth-forms.tsx");
    const reset = forms.slice(
      forms.indexOf("export function ResetPasswordForm"),
      forms.indexOf("export function ResendVerificationForm"),
    );

    assert.doesNotMatch(reset, /id="confirm"/, "the confirm field is back");
    assert.equal(
      [...reset.matchAll(/<PasswordInput/g)].length,
      1,
      "the reset form no longer has exactly one password field",
    );

    const input = /<PasswordInput[\s\S]*?\/>/.exec(reset)?.[0] ?? "";
    assert.doesNotMatch(input, /value=\{/, "the password field is controlled again");
    assert.doesNotMatch(input, /onChange=\{/, "the password field mirrors into state again");
    assert.doesNotMatch(
      reset,
      /useState/,
      "the reset form holds React state, which is how the password got overwritten",
    );
  });

  test("password-manager metadata is correct on every auth form", () => {
    const forms = read("src/components/app/auth-forms.tsx");
    // A password manager needs a stable name, a stable id and the right
    // autocomplete token to offer generation and to save afterwards.
    for (const [label, needle] of [
      ["sign-in password", /id="password"\s+name="password"\s+autoComplete="current-password"/],
      ["new password", /id="password"[\s\S]{0,160}autoComplete="new-password"/],
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

  test("a password below the minimum is refused without spending the token", async () => {
    // The confirm field is gone, so this is the failure mode that replaced the
    // mismatch: the person can try again, which is the whole point of not
    // consuming a token on anything short of success.
    const userId = await account();
    const { issueToken } = await import("../../src/lib/auth/tokens");
    const { resetPasswordAction } = await import("../../src/lib/actions/auth");
    const { token } = await issueToken(userId, "password_reset", {});

    const form = new FormData();
    form.set("token", token);
    form.set("password", "short");
    const result = await resetPasswordAction(null, form);
    assert.equal(result.ok, false, "a five-character password was accepted");

    const row = await db.authToken.findFirst({ where: { userId }, select: { usedAt: true } });
    assert.equal(row?.usedAt, null, "a rejected password spent the token");
  });

  test("the length limit is enforced in bytes, on the server", async () => {
    // bcrypt truncates at 72 *bytes* and says nothing about it, so anything
    // past that is a lie about strength. The forms carry a `maxlength`, but it
    // counts UTF-16 code units: 72 emoji are 288 bytes and would sail through
    // it. The check that matters is therefore the server's, and it has to be
    // measured in the unit bcrypt actually truncates on.
    const userId = await account();
    const { issueToken } = await import("../../src/lib/auth/tokens");
    const { resetPasswordAction } = await import("../../src/lib/actions/auth");
    const { PASSWORD_MAX_BYTES, passwordByteLength } = await import("../../src/lib/auth/password");

    // Comfortably inside any character count, comfortably past the byte limit.
    const overLimit = "🔐".repeat(20); // 20 characters, 80 bytes
    assert.ok(overLimit.length < PASSWORD_MAX_BYTES, "the fixture is not shorter than the limit in characters");
    assert.ok(passwordByteLength(overLimit) > PASSWORD_MAX_BYTES, "the fixture is not over the limit in bytes");

    const { token } = await issueToken(userId, "password_reset", {});
    const form = new FormData();
    form.set("token", token);
    form.set("password", overLimit);
    const result = await resetPasswordAction(null, form);
    assert.equal(result.ok, false, "a password past bcrypt's byte limit was accepted");

    const row = await db.authToken.findFirst({ where: { userId }, select: { usedAt: true } });
    assert.equal(row?.usedAt, null, "an over-long password spent the token");
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
    const result = await resetPasswordAction(null, form);
    assert.equal(result.ok, true, `a generated-style password was refused: ${JSON.stringify(result)}`);

    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    const hash = user.passwordHash;
    assert.ok(hash, "the account lost its password hash");
    assert.ok(await bcrypt.compare(generated, hash), "the new password was not the one submitted");
    assert.ok(!hash.includes(generated), "the password is stored in readable form");
  });

  test("every password field in the product can be revealed", () => {
    // A masked field the person cannot check is how a typo becomes a lockout,
    // and it is the reason a confirm field felt necessary in the first place.
    // The control replaces it, so it has to actually be everywhere.
    for (const [file, expected] of [
      ["src/components/app/auth-forms.tsx", 3], // sign in, sign up, reset
      ["src/components/app/security-settings.tsx", 1], // turning two-factor off
    ] as const) {
      const source = read(file);
      assert.doesNotMatch(
        source,
        /<Input[^>]*type="password"/,
        `${file} has a raw password input with no way to reveal it`,
      );
      assert.equal(
        [...source.matchAll(/<PasswordInput/g)].length,
        expected,
        `${file} does not have the expected number of password fields`,
      );
    }
  });

  test("the reveal control cannot submit the form it sits in", () => {
    // A bare <button> inside a form defaults to type="submit", which would turn
    // "let me check what I typed" into a submission — and on the reset form,
    // into a spent token.
    const source = read("src/components/ui/password-input.tsx");
    assert.match(source, /<button\s+type="button"/, "the reveal control can submit the form");
    assert.match(
      source,
      /aria-label=\{label\}/,
      "the control's accessible name does not track its state",
    );
  });

  test("the reveal control holds no password state", () => {
    // It toggles an attribute on the same node. Anything that mirrors the value
    // — or that keys the input off visibility, remounting it — loses whatever
    // the browser wrote there.
    const source = read("src/components/ui/password-input.tsx");
    assert.doesNotMatch(source, /useState<string>|useState\(""\)/, "the control mirrors the password into state");
    assert.doesNotMatch(source, /key=\{/, "the input is keyed, so toggling remounts it and drops the value");
    assert.match(source, /type=\{visible \? "text" : "password"\}/, "visibility is not a plain attribute swap");
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
