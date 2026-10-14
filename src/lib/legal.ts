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
 * When the email and calendar sections of the privacy notice take effect.
 *
 * Separate from LEGAL_EFFECTIVE_ON, and deliberately so. The notice in force
 * today is unchanged and stays authoritative until this date; what publishes
 * on 20 October is the *current* notice plus a set of clearly marked future
 * sections. Folding the two into one constant would re-date the whole
 * document and, with it, every acceptance recorded against it.
 *
 * The 30-day commitment in § 12 runs from the day each customer is emailed,
 * not from publication. This date is 34 days after the send so a slipped
 * send does not quietly eat into the period — see
 * src/lib/legal/notice-window.ts, which computes the real gate from the
 * latest acceptance rather than from this constant.
 *
 * It is a display date. It does not enable anything: customer integrations
 * stay behind their own flags, and turning them on is gated on the notice
 * window and the delivery reconciliation, not on the calendar reaching this
 * day.
 */
export const INTEGRATIONS_EFFECTIVE_ON = "2026-11-23";

/** "23 November 2026", for the page. UTC-parsed, as above. */
export function integrationsEffectiveDate(): string {
  const [year, month, day] = INTEGRATIONS_EFFECTIVE_ON.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

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
