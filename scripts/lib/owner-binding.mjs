/**
 * Who may be bound to the owner-admin panel, and every reason a binding is
 * refused.
 *
 * This lives apart from `bind-platform-admin.mjs` so the decision can be
 * tested. The script is the hands; this is the judgement. A guard that is
 * defined and never called is worse than no guard, because it reads like
 * protection in review — that mistake has already been made once on this
 * feature, so the test that covers these rules also asserts the script calls
 * them.
 */

/**
 * The one address allowed to hold administration.
 *
 * Hard-coded on purpose. The binding is the **user id** — that is what the
 * row stores and what the panel resolves — but an id is twelve characters of
 * noise, and the failure this prevents is a *correctly typed id for the wrong
 * account*: a real, live customer, silently holding the panel, with every
 * verification passing because the id resolved to somebody. Checking the
 * address the id resolves to turns that from a silent success into a refusal.
 *
 * There is no flag to override it. An administrator for a different address is
 * a change to this line, reviewed like any other.
 */
export const OWNER_ADMIN_EMAIL = "hello@artifactdigital.co";

/**
 * Exact match, case-insensitive, whitespace trimmed — and nothing else.
 *
 * No subdomain, suffix or plus-address leniency: `hello+admin@…` and
 * `hello@artifactdigital.com` are *different accounts* in this product, with
 * different ids, and the entire point of this check is to notice that.
 */
/**
 * @param {unknown} email
 * @returns {boolean}
 */
export function isOwnerAddress(email) {
  return typeof email === "string" && email.trim().toLowerCase() === OWNER_ADMIN_EMAIL;
}

/**
 * Why this binding is refused, or `null` to proceed.
 *
 * Unbinding deliberately skips the address, suspension and single-admin rules.
 * Those exist to stop administration being *created* in the wrong place; every
 * one of them would otherwise block the recovery from having done so.
 */
/**
 * @typedef {{ id: string, email: string, deactivatedAt?: Date | null }} Account
 * @typedef {{ userId: string, email: string }} ExistingAdmin
 *
 * @param {{ unbind?: boolean, account?: Account | null, existing?: ExistingAdmin[] }} [options]
 * @returns {string | null}
 */
export function bindingRefusal({ unbind = false, account = null, existing = [] } = {}) {
  if (!account) return "no account with that id.";
  if (unbind) return null;

  if (!isOwnerAddress(account.email)) {
    return (
      `that account is ${account.email}, not ${OWNER_ADMIN_EMAIL}. ` +
      `Administration is bound to one address; resolve the id again.`
    );
  }
  if (account.deactivatedAt) return "that account is suspended. Reinstate it first.";

  const other = existing.find((row) => row.userId !== account.id);
  if (other) {
    return (
      `administration is already bound to ${other.email}. ` +
      `This version supports one administrator; unbind the existing one first.`
    );
  }
  return null;
}
