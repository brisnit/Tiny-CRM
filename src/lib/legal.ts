/**
 * The published legal documents, and the version a signup accepts.
 *
 * ## One constant, deliberately
 *
 * The date shown on `/privacy` and `/terms` and the version string recorded
 * against a user's acceptance are the *same* fact: which text they agreed to. Two
 * constants could drift, and a drift here means a stored acceptance that points
 * at a version no page ever displayed — unanswerable in a dispute, which is the
 * one thing an acceptance record exists for.
 *
 * ## This must equal the intended publication date
 *
 * It is the effective date both documents display, so it must not be earlier than
 * the day they actually go live — a page claiming it took effect before anyone
 * could read it is simply wrong. If publication slips past the date below, change
 * it. One line.
 *
 * An earlier version of this comment overstated the risk, and the correction is
 * worth keeping: a recorded *version* dated before publication is not by itself a
 * false acceptance record. The version identifies **which text** was agreed to;
 * `User.termsAcceptedAt` records **when** the agreement happened. Those are two
 * different facts and only the second is a timestamp of consent. What would be
 * wrong is the page implying an effective date it did not have.
 *
 * It is deliberately **not** generated from the clock: a value that moved on its
 * own would silently re-date a document nobody edited, and acceptances already
 * recorded would then name a version string that no page had ever displayed.
 */
export const LEGAL_EFFECTIVE_ON = "2026-10-05";

/**
 * The version recorded on `User.termsAcceptedVersion`.
 *
 * Same value as the effective date, by design — see above. Kept as its own export
 * so call sites read as what they mean.
 */
export const TERMS_VERSION = LEGAL_EFFECTIVE_ON;

/**
 * The effective date as prose, for the page header: "5 October 2026".
 *
 * Parsed as UTC rather than local time. `new Date("2026-10-05")` is midnight UTC,
 * and formatting that in a timezone behind UTC prints the 4th — the same class of
 * off-by-one-day bug the repository already has a standing note about.
 */
export function legalEffectiveDate(): string {
  const [year, month, day] = LEGAL_EFFECTIVE_ON.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
