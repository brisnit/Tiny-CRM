import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Stable, URL-safe slug. Used for workspace slugs and anchor ids. */
export function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Deterministic colour pick so the same name always gets the same avatar tint.
 */
export function colorForKey(key: string) {
  const palette = [
    "#068C28", "#3DBE46", "#0F766E", "#2563EB", "#7C3AED",
    "#DB2777", "#EA580C", "#CA8A04", "#0891B2", "#4F46E5",
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

export function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Strips HTML to a plain-text projection for search indexes and AI context. */
export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K) {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * A file size a person can read.
 *
 * The five record pages that list files each inline
 * `Math.round(sizeBytes / 1024) + " KB"`, which reports "0 KB" for anything
 * under half a kilobyte and never reaches megabytes. A 12-byte text file and an
 * empty one therefore look identical, and a 40 MB video reads as "40960 KB".
 *
 * Below a kilobyte the exact byte count is the useful number, so it is kept.
 * Above it, one decimal while the mantissa is small — 1.4 MB says something
 * 1 MB does not — and none once it is large enough that the decimal is noise.
 *
 * Binary units throughout (1 KB = 1024 bytes), matching how the upload limit is
 * expressed in src/lib/validation/limits.ts.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} ${Math.round(bytes) === 1 ? "byte" : "bytes"}`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}
