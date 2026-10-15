/**
 * When a notice period has actually elapsed for *everyone*.
 *
 * ## The off-by-one-person mistake this exists to prevent
 *
 * A notice commitment reads "at least 30 days' notice by email to your
 * account address". It is a promise to each person, not to the population, so
 * it is satisfied only when the person notified **last** has had their 30
 * days.
 *
 * An earlier draft of the activation rule said the opposite — that activation
 * could proceed once "the earliest acceptance" was 30 days old. With a send
 * that completes in one batch the two are indistinguishable, which is exactly
 * why it survived review. With a staggered send they are not:
 *
 *   person A accepted on day 0
 *   person B accepted on day 10   (a retry, a bounce chased up, a second run)
 *
 * On day 31 the earliest acceptance is 31 days old and the rule would have
 * said go. B has had 21 days. B is owed 30, and B is the one most likely to
 * have been missed in the first place.
 *
 * So the window is computed from the **maximum** acceptance time. Taking the
 * latest is the whole content of this module; everything else is reporting.
 *
 * Deliberately pure and in `src/` rather than inside the operator script, so
 * the rule is covered by the test suite rather than by whoever last read the
 * script.
 */

/** The commitment in both the privacy notice (§ 12) and the terms (§ 11). */
export const NOTICE_DAYS = 30;

export type NoticeWindow = {
  /** Usable acceptances. Zero means nobody has been given notice. */
  count: number;
  /**
   * Acceptances whose timestamp could not be read.
   *
   * Any at all blocks the check. See `blocked`.
   */
  invalid: number;
  /** First acceptance — reported for context, never used for the decision. */
  earliest: Date | null;
  /** Last acceptance. This is what the window is measured from. */
  latest: Date | null;
  /** The first instant activation is permissible for everyone. */
  activationFrom: Date | null;
  /** True when `at` is on or after `activationFrom` AND nothing is blocked. */
  elapsed: boolean;
  /** Whole days still to wait, 0 when elapsed, Infinity when blocked. */
  daysRemaining: number;
  /** Why the check cannot be satisfied at all, or null. */
  blocked: string | null;
};

/**
 * @param acceptances when each recipient's notice was accepted by the provider
 * @param options.at the moment to judge against, defaulting to now
 * @param options.noticeDays the commitment, defaulting to 30
 */
export function noticeWindow(
  acceptances: readonly Date[],
  options: { at?: Date; noticeDays?: number } = {},
): NoticeWindow {
  const at = options.at ?? new Date();
  const noticeDays = options.noticeDays ?? NOTICE_DAYS;

  const usable: number[] = [];
  let invalid = 0;
  for (const d of acceptances) {
    const t = d instanceof Date ? d.getTime() : Number.NaN;
    if (Number.isFinite(t)) usable.push(t);
    else invalid += 1;
  }
  usable.sort((a, b) => a - b);

  /**
   * An unreadable timestamp blocks the check. It does not get discarded.
   *
   * The first version of this filtered them out and computed the window from
   * what was left, on the reasoning that a NaN would otherwise poison every
   * comparison. That reasoning was right about the symptom and wrong about
   * the remedy: discarding means a recipient whose acceptance time cannot be
   * read silently stops counting, and the window is then computed from the
   * others — which is more permissive, not less.
   *
   * If we cannot say when somebody was notified, we cannot claim their 30
   * days have elapsed. The honest answer is to refuse, name the problem, and
   * make a person look at the ledger.
   */
  if (invalid > 0) {
    return {
      count: usable.length,
      invalid,
      earliest: usable.length ? new Date(usable[0]!) : null,
      latest: usable.length ? new Date(usable[usable.length - 1]!) : null,
      activationFrom: null,
      elapsed: false,
      daysRemaining: Number.POSITIVE_INFINITY,
      blocked:
        `${invalid} acceptance timestamp(s) could not be read. When a recipient's ` +
        `acceptance time is unknown, their notice period cannot be shown to have ` +
        `elapsed — fix the ledger rather than proceeding on the rest.`,
    };
  }

  if (usable.length === 0) {
    // Nobody has been given notice, so no amount of waiting makes activation
    // permissible. Not "elapsed", and not a number of days either.
    return {
      count: 0,
      invalid: 0,
      earliest: null,
      latest: null,
      activationFrom: null,
      elapsed: false,
      daysRemaining: Number.POSITIVE_INFINITY,
      blocked: "nobody has been given notice",
    };
  }
  const times = usable;

  const earliest = new Date(times[0]!);
  const latest = new Date(times[times.length - 1]!);
  const activationFrom = new Date(latest.getTime() + noticeDays * 86_400_000);
  const elapsed = at.getTime() >= activationFrom.getTime();

  return {
    count: times.length,
    invalid: 0,
    earliest,
    latest,
    activationFrom,
    elapsed,
    daysRemaining: elapsed
      ? 0
      : Math.ceil((activationFrom.getTime() - at.getTime()) / 86_400_000),
    blocked: null,
  };
}
