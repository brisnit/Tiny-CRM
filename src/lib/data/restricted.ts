import type { ReadScope } from "@/lib/auth/access";
import { AppError } from "@/lib/errors";

/**
 * What a restricted member receives, as opposed to what they may reach.
 *
 * RLS decides whether a row exists for someone. It cannot turn a full record
 * into a partial one — there is no column-level equivalent of a row policy —
 * so the identity projection lives here, one layer above the boundary, and is
 * pinned by tests/security/company-columns.test.ts, which enumerates Company's
 * columns from the Prisma schema and fails when a new one appears unclassified.
 *
 * That split is worth being honest about: row visibility is enforced by the
 * database and cannot be forgotten; column visibility is enforced by this file
 * and can be, which is why the enumeration test exists.
 */

/** Whether this reader is confined to granted records in this workspace. */
export function isRestrictedIn(read: ReadScope, workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return (read.restrictedWorkspaceIds ?? []).length > 0;
  return (read.restrictedWorkspaceIds ?? []).includes(workspaceId);
}

/** Whether this reader is confined anywhere in the scope they are reading with. */
export function isRestrictedReader(read: ReadScope): boolean {
  return (read.restrictedWorkspaceIds ?? []).length > 0;
}

/**
 * The company fields a restricted member may see.
 *
 * Identity, and nothing about our relationship with them: no revenue band, no
 * lead source, no relationship status, no internal description, no account
 * owner, no last-activity timestamp, no counts. Enough to know who the buyer
 * on their opportunity is; not enough to learn how the account is doing.
 */
export const COMPANY_IDENTITY_FIELDS = [
  "id",
  "name",
  "domain",
  "website",
  "industry",
  "logoUrl",
  "location",
  "size",
] as const;

export type CompanyIdentityField = (typeof COMPANY_IDENTITY_FIELDS)[number];

/**
 * Carried alongside the identity, and deliberately not part of it.
 *
 * `workspaceId` is the tenant key, not information about the company: the
 * reader is a member of that workspace and already knows its id. Server
 * components need it to scope the things they render next. It is named here
 * rather than folded into the identity list so the approved eight stay exactly
 * the eight that were approved.
 */
const COMPANY_SCOPE_FIELDS = ["workspaceId"] as const;
type CompanyScopeField = (typeof COMPANY_SCOPE_FIELDS)[number];

/**
 * Narrows one company row to its identity.
 *
 * The return type keeps the identity fields required and makes everything else
 * optional, so a caller that renders a name still compiles while a caller that
 * reaches for the revenue band is told it may not be there. That is the point:
 * the screens a restricted member can open have to be written for what they
 * receive.
 */
export function companyIdentity<T extends Record<string, unknown>>(
  row: T,
): CompanyIdentity<T> {
  const out: Record<string, unknown> = { identityOnly: true };
  for (const field of [...COMPANY_IDENTITY_FIELDS, ...COMPANY_SCOPE_FIELDS]) {
    if (field in row) out[field] = row[field];
  }
  return out as CompanyIdentity<T>;
}

/**
 * The projected shape, marked.
 *
 * `identityOnly` is a discriminant, not data: a caller that renders a company
 * has to decide what to do when most of it is absent, and a flag makes that a
 * branch the compiler checks rather than a series of optional-chaining
 * accidents.
 */
export type CompanyIdentity<T> = Pick<
  T,
  Extract<keyof T, CompanyIdentityField | CompanyScopeField>
> & { identityOnly: true };

/**
 * Contact fields a restricted member does not receive.
 *
 * The person is visible because they are attached to work the member holds.
 * That says nothing about how we rate them (`importance`), where they came
 * from (`leadSource`), what a colleague wrote about them (`description`), or
 * who owns the relationship (`ownerId`, `owner`) — and the relationship counts
 * describe records the member may not see at all.
 */
const CONTACT_PRIVATE_FIELDS = [
  "description",
  "importance",
  "leadSource",
  "ownerId",
  "owner",
  "_count",
  "relationship",
] as const;

/** Removes the fields above from one contact row. */
export function contactWithoutPrivateFields<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const field of CONTACT_PRIVATE_FIELDS) delete out[field];
  return out as T;
}

/**
 * Refuses a surface that cannot be made safe for a restricted member yet.
 *
 * Duplicate detection, pasted-text classification and CSV export exist to
 * enumerate records; narrowing their queries does not make them correct, it
 * makes them quietly wrong — a duplicate report that under-reports, a
 * "create new" where a link was right. Refusing says so out loud until each
 * is redesigned for scoped readers.
 */
export function refuseForRestricted(read: ReadScope, what: string): void {
  if (!isRestrictedReader(read)) return;
  throw new AppError("forbidden", `${what} is not available with your level of access.`);
}
