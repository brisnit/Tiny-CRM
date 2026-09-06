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
 * True when a stored hash was produced with weaker parameters than current
 * policy, so it can be transparently upgraded on the user's next sign-in.
 */
export function needsRehash(hash: string): boolean {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  if (!match) return true;
  return Number(match[1]) < PASSWORD_HASH_COST;
}
