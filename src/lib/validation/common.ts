import { z } from "zod";

import { LIMITS } from "@/lib/validation/limits";

/**
 * Shared validation primitives.
 *
 * Every trust boundary — server actions, route handler query strings, form
 * payloads, CSV rows, AI extraction output — parses through schemas built from
 * these. TypeScript types are erased at runtime and validate nothing; these do.
 */

/**
 * Record identifiers. Prisma generates cuids, so anything that is not a
 * plausible id is rejected before it can reach a `where` clause. This is not a
 * security control on its own (authorization is), but it turns malformed input
 * into a clean validation error instead of a database round-trip.
 */
export const zId = z
  .string()
  .trim()
  .min(1, "Missing identifier")
  .max(64, "Malformed identifier")
  .regex(/^[A-Za-z0-9_-]+$/, "Malformed identifier");

/** An optional id: empty string, "__none__" (the select placeholder) and null all mean absent. */
export const zOptionalId = z
  .union([zId, z.literal(""), z.literal("__none__"), z.null()])
  .transform((v) => (v === "" || v === "__none__" || v == null ? null : v))
  .optional();

export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, "That email is too long")
  .email("That email doesn't look right");

export const zOptionalEmail = z
  .union([zEmail, z.literal(""), z.null()])
  .transform((v) => (v ? v : null))
  .optional();

/**
 * URLs are restricted to http(s). Accepting `javascript:` or `data:` here would
 * put an XSS payload one render away, since these values are shown as links.
 */
export const zUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      if (!value) return true;
      try {
        const url = new URL(value.startsWith("http") ? value : `https://${value}`);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Enter a valid http(s) URL" },
  );

export const zOptionalUrl = z
  .union([zUrl, z.literal(""), z.null()])
  .transform((v) => (v ? v : null))
  .optional();

export const zShortText = z.string().trim().max(LIMITS.shortText);
export const zMediumText = z.string().trim().max(LIMITS.mediumText);
export const zLongText = z.string().trim().max(LIMITS.longText);

/** Optional free text: blanks become null so the database never holds "". */
export const zOptionalText = (max: number = LIMITS.mediumText) =>
  z
    .union([z.string(), z.null()])
    .transform((v) => {
      if (v == null) return null;
      const trimmed = v.trim();
      return trimmed === "" || trimmed === "__none__" ? null : trimmed.slice(0, max);
    })
    .optional();

/** Rich text. Sanitised separately; this only bounds the size. */
export const zRichText = z.string().max(LIMITS.richText).default("");

/** Dates arriving as strings from date inputs, bounded to a sane window. */
export const zOptionalDate = z
  .union([z.string(), z.date(), z.null()])
  .transform((value, ctx) => {
    if (value == null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "That date is not valid" });
      return null;
    }
    const year = date.getUTCFullYear();
    if (year < LIMITS.minYear || year > LIMITS.maxYear) {
      ctx.addIssue({ code: "custom", message: "That date is out of range" });
      return null;
    }
    return date;
  })
  .optional();

/**
 * Money in, integer minor units out. Rejects NaN, Infinity and absurd values
 * rather than storing them.
 */
export const zOptionalMoney = z
  .union([z.string(), z.number(), z.null()])
  .transform((value, ctx) => {
    if (value == null || value === "") return null;
    const raw = typeof value === "string" ? Number(value.replace(/[^0-9.-]/g, "")) : value;
    if (!Number.isFinite(raw)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid amount" });
      return null;
    }
    const cents = Math.round(raw * 100);
    if (Math.abs(cents) > LIMITS.maxMoneyCents) {
      ctx.addIssue({ code: "custom", message: "That amount is out of range" });
      return null;
    }
    return cents;
  })
  .optional();

export const zOptionalInt = (min: number = -1_000_000, max: number = 1_000_000) =>
  z
    .union([z.string(), z.number(), z.null()])
    .transform((value, ctx) => {
      if (value == null || value === "") return null;
      const n = typeof value === "string" ? Number(value) : value;
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Enter a number" });
        return null;
      }
      const rounded = Math.round(n);
      if (rounded < min || rounded > max) {
        ctx.addIssue({ code: "custom", message: `Enter a number between ${min} and ${max}` });
        return null;
      }
      return rounded;
    })
    .optional();

/** Percentage, 0-100. */
export const zOptionalPercent = zOptionalInt(0, 100);

/** Tag names, deduplicated and bounded. */
export const zTags = z
  .array(z.string().trim().min(1).max(60))
  .max(30)
  .optional()
  .transform((tags) => (tags ? Array.from(new Set(tags)) : undefined));

/** A batch of ids for a bulk action. */
export const zIdBatch = z.array(zId).min(1, "Select at least one record").max(LIMITS.maxBulkIds);

/**
 * Optimistic concurrency token. Clients echo the version they loaded; a stale
 * value means someone else saved first.
 */
export const zVersion = z.number().int().min(0).optional();

// ---------------------------------------------------------------------------
// Query-string schemas for route handlers
// ---------------------------------------------------------------------------

export const zSearchQuery = z
  .string()
  .trim()
  .min(LIMITS.searchQuery.min)
  .max(LIMITS.searchQuery.max);

export const zScope = z
  .union([zId, z.literal("all"), z.null(), z.undefined()])
  .transform((v) => (v == null ? "all" : v));

export const zPagination = z.object({
  page: z.coerce.number().int().min(1).max(LIMITS.maxPage).catch(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSize.max).catch(LIMITS.pageSize.default),
});

/** Parses a URL's search params through a schema, with safe fallbacks. */
export function parseSearchParams<T extends z.ZodTypeAny>(
  schema: T,
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): z.infer<T> {
  const record =
    params instanceof URLSearchParams
      ? Object.fromEntries(params.entries())
      : Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
        );
  return schema.parse(record);
}
