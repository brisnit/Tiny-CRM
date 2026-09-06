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
