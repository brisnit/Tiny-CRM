import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isThisYear,
  isToday,
  isTomorrow,
  isYesterday,
  startOfDay,
} from "date-fns";

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Today", "Tomorrow", "Mar 4" — the default for due dates and deadlines. */
export function formatDay(value: Date | string | null | undefined, fallback = "—") {
  const date = toDate(value);
  if (!date) return fallback;
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  if (isYesterday(date)) return "Yesterday";
  return format(date, isThisYear(date) ? "MMM d" : "MMM d, yyyy");
}

export function formatDate(value: Date | string | null | undefined, fallback = "—") {
  const date = toDate(value);
  return date ? format(date, "MMM d, yyyy") : fallback;
}

export function formatDateTime(value: Date | string | null | undefined, fallback = "—") {
  const date = toDate(value);
  return date ? format(date, "MMM d, yyyy · h:mm a") : fallback;
}

export function formatTime(value: Date | string | null | undefined, fallback = "—") {
  const date = toDate(value);
  return date ? format(date, "h:mm a") : fallback;
}

/** "3 days ago" */
export function timeAgo(value: Date | string | null | undefined, fallback = "never") {
  const date = toDate(value);
  return date ? `${formatDistanceToNowStrict(date)} ago` : fallback;
}

/** Whole days from today. Negative means in the past. */
export function daysFromNow(value: Date | string | null | undefined): number | null {
  const date = toDate(value);
  return date ? differenceInCalendarDays(startOfDay(date), startOfDay(new Date())) : null;
}

export function daysSince(value: Date | string | null | undefined): number | null {
  const days = daysFromNow(value);
  return days === null ? null : -days;
}

/** "in 5 days" / "4 days overdue" / "Today" — used on every deadline chip. */
export function describeDeadline(value: Date | string | null | undefined) {
  const days = daysFromNow(value);
  if (days === null) return { label: "No date", overdue: false, urgent: false };
  if (days < 0) {
    const n = Math.abs(days);
    return { label: `${n} day${n === 1 ? "" : "s"} overdue`, overdue: true, urgent: true };
  }
  if (days === 0) return { label: "Due today", overdue: false, urgent: true };
  if (days === 1) return { label: "Due tomorrow", overdue: false, urgent: true };
  if (days <= 7) return { label: `In ${days} days`, overdue: false, urgent: days <= 3 };
  return { label: formatDay(value), overdue: false, urgent: false };
}

export function dateInputValue(value: Date | string | null | undefined) {
  const date = toDate(value);
  return date ? format(date, "yyyy-MM-dd") : "";
}

export function dateTimeInputValue(value: Date | string | null | undefined) {
  const date = toDate(value);
  return date ? format(date, "yyyy-MM-dd'T'HH:mm") : "";
}

/** Current month key used by usage counters, e.g. "2026-09". */
export function currentPeriod(now = new Date()) {
  return format(now, "yyyy-MM");
}

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

/**
 * A deadline is a day, not an instant.
 *
 * Everything above formats in the viewer's local timezone, which is right for a
 * timestamp — "created 3 minutes ago" means the same moment everywhere. It is
 * wrong for a calendar date. A proposal due on 2026-09-29 is due on the 29th in
 * San Diego and in Tokyo; it is not due a day earlier because the reader is
 * west of Greenwich.
 *
 * Those values arrive from a `<input type="date">` as "2026-09-29" and are
 * stored as 2026-09-29T00:00:00Z, which is the correct canonical form — the
 * stored data is right. What was wrong was reading it back through a local
 * formatter, which in Pacific renders the instant before midnight UTC as the
 * 28th.
 *
 * That produced two bugs, and the second is the serious one:
 *
 *   1. Every deadline displayed a day early west of UTC.
 *   2. `dateInputValue` pre-filled edit forms with that same shifted day, so
 *      opening a record and saving it moved the date back one day — and doing
 *      it twice moved it two. A date walked backwards every time somebody
 *      touched the record.
 *
 * So calendar dates get their own vocabulary, and it reads and writes in UTC.
 * The names are deliberately not interchangeable with the ones above: a
 * reviewer seeing `formatDate(task.dueAt)` should be able to tell it is wrong
 * without knowing this history.
 */

/** The calendar day a date-only value denotes, from its UTC parts. */
function civilFromUtc(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * The same calendar day, rebuilt at *local* midnight.
 *
 * date-fns formats in local time and there is no arguing with that, so the
 * value handed to it has to already be the right day locally. Taking the UTC
 * parts and constructing a local date from them is what does that: 2026-09-29
 * stored as midnight UTC becomes 2026-09-29 at local midnight, and formats as
 * the 29th wherever it is read.
 *
 * The first version of this passed the UTC instant straight to `format` and
 * reproduced the original bug exactly — the tests caught it.
 */
function civilDate(date: Date): Date {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The viewer's own calendar day, from their local clock. */
function civilToday(now = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/** "Sep 29, 2026" — the same day in every timezone. */
export function formatDateOnly(value: Date | string | null | undefined, fallback = "—") {
  const date = toDate(value);
  if (!date) return fallback;
  return format(civilDate(date), "MMM d, yyyy");
}

/**
 * "Today", "Tomorrow", "Sep 29" — the same day in every timezone.
 *
 * "Today" is still relative to the *viewer's* day, which is the point: the
 * value is a fixed calendar date and the reader is the one moving.
 */
export function formatDayOnly(value: Date | string | null | undefined, fallback = "—") {
  const date = toDate(value);
  if (!date) return fallback;
  const days = daysFromNowDateOnly(date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const civil = civilDate(date);
  return format(civil, isThisYear(civil) ? "MMM d" : "MMM d, yyyy");
}

/** What an `<input type="date">` should be pre-filled with. */
export function dateOnlyInputValue(value: Date | string | null | undefined) {
  const date = toDate(value);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from the viewer's today. Negative means past. */
export function daysFromNowDateOnly(
  value: Date | string | null | undefined,
  now = new Date(),
): number | null {
  const date = toDate(value);
  if (!date) return null;
  return Math.round((civilFromUtc(date) - civilToday(now)) / 86_400_000);
}

/** `describeDeadline`, for values that are calendar dates rather than instants. */
export function describeDateOnlyDeadline(value: Date | string | null | undefined) {
  const days = daysFromNowDateOnly(value);
  if (days === null) return { label: "No date", overdue: false, urgent: false };
  if (days < 0) {
    const n = Math.abs(days);
    return { label: `${n} day${n === 1 ? "" : "s"} overdue`, overdue: true, urgent: true };
  }
  if (days === 0) return { label: "Due today", overdue: false, urgent: true };
  if (days === 1) return { label: "Due tomorrow", overdue: false, urgent: true };
  if (days <= 7) return { label: `In ${days} days`, overdue: false, urgent: days <= 3 };
  return { label: formatDayOnly(value), overdue: false, urgent: false };
}

/** `daysSince`, for calendar dates. Positive means in the past. */
export function daysSinceDateOnly(
  value: Date | string | null | undefined,
  now = new Date(),
): number | null {
  const days = daysFromNowDateOnly(value, now);
  return days === null ? null : -days;
}
