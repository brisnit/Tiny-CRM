import { createHash } from "node:crypto";

/**
 * Recognising a production database without naming one.
 *
 * A digest of host and database name, so this file can identify production
 * while containing no hostname and certainly no credential. Shared by every
 * operator script that must refuse to act on the wrong database — one
 * definition, because two would drift and the drift would show up as a
 * check that silently stopped recognising production.
 */
export function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

export const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint"],
]);

/** The name of the database this URL points at, or null if unrecognised. */
export function identifyDatabase(url) {
  return PRODUCTION_FINGERPRINTS.get(fingerprint(url)) ?? null;
}
