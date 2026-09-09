/**
 * Password hashing parameters.
 *
 * bcrypt at cost 12. The prototype used the library default of 10; 12 is the
 * current OWASP baseline and roughly quadruples the work per guess, at about
 * 250ms per hash on typical server hardware — slow enough to matter to an
 * attacker, fast enough not to matter to a sign-in.
 *
 * Argon2id is the stronger choice and is what this should become, but it needs a
 * native module; the cost constant is isolated here so the migration is a single
 * file plus a rehash-on-next-login step (`needsRehash` below is the hook).
 */
export const PASSWORD_HASH_COST = 12;

/** Minimum length. Length beats composition rules; NIST agrees. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * The upper bound, in **bytes** — not characters.
 *
 * bcrypt truncates its input at 72 bytes and says nothing about it, so a longer
 * password is a lie about strength: every candidate sharing the first 72 bytes
 * opens the account. The limit therefore has to be refused rather than silently
 * absorbed.
 *
 * Bytes, because that is the unit bcrypt actually counts. A JavaScript string's
 * `.length` is UTF-16 code units, and an HTML `maxlength` counts something
 * similar; either measure lets 72 "characters" of accented Latin, CJK or emoji
 * cross the byte limit unnoticed. `maxlength` in the markup is a convenience
 * that keeps a runaway paste out of the request — it is never the check, and it
 * is deliberately looser in bytes than this one so it cannot reject a password
 * the server would have accepted.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * UTF-8 byte length, measured the same way in a browser and on the server.
 *
 * `TextEncoder` rather than `Buffer`, because this constant and its helper are
 * imported by client components for their length hints, and `Buffer` is not a
 * browser global.
 */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * True when a stored hash was produced with weaker parameters than current
 * policy, so it can be transparently upgraded on the user's next sign-in.
 */
export function needsRehash(hash: string): boolean {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  if (!match) return true;
  return Number(match[1]) < PASSWORD_HASH_COST;
}
