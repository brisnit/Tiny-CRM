/**
 * What a spreadsheet column can become.
 *
 * This registry is the whole of the importer's knowledge about Tiny's own
 * shape. Nothing else in `src/lib/import/` knows that opportunities have
 * deadlines or that companies have a domain, which is what keeps the importer
 * generic: a client list, a vendor list and an RFP tracker all arrive as a grid
 * and are matched against the same table.
 *
 * Adding a field to an import is adding a row here.
 */

import { LIMITS } from "@/lib/validation/limits";
import {
  COMPANY_SIZE, COMPANY_TYPE, LEAD_SOURCE, OPPORTUNITY_TYPE, RELATIONSHIP_STATUS,
  RELATIONSHIP_TYPE, SUBMISSION_STATUS, TASK_PRIORITY,
} from "@/lib/enums";

/** The record types an import can create. Rollback knows this same list. */
export const IMPORT_ENTITIES = ["company", "contact", "opportunity", "task"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export type FieldKind =
  | "text" | "longtext" | "date" | "money" | "int" | "boolean" | "enum"
  /** Resolved to another record by name, creating it when it does not exist. */
  | "reference";

export type FieldTarget = {
  key: string;
  entity: ImportEntity;
  field: string;
  label: string;
  kind: FieldKind;
  aliases: readonly string[];
  options?: readonly string[];
  /** Values this column is known to use that map onto an option. */
  optionAliases?: Record<string, string>;
  max?: number;
  min?: number;
  /** The entity this reference resolves to. */
  referenceTo?: ImportEntity;
  /**
   * Tiny recalculates this from the underlying facts, so importing the
   * spreadsheet's copy would freeze a value that is supposed to move. The
   * column is still preserved on the import row as source provenance — it is
   * simply not written onto the record as if it were current.
   */
  derived?: boolean;
  /** Shown in the mapping UI when the column is one people get wrong. */
  hint?: string;
};

/**
 * The one field that has to be present for a record of this type to be worth
 * creating. A row with no value here is not a record, it is a stray.
 */
export const REQUIRED_FIELD: Record<ImportEntity, string> = {
  company: "name",
  contact: "fullName",
  opportunity: "name",
  task: "title",
};

const T = (t: FieldTarget) => t;

export const FIELD_TARGETS: readonly FieldTarget[] = [
  // ---- Company -----------------------------------------------------------
  T({ key: "company.name", entity: "company", field: "name", label: "Company name", kind: "text",
      max: LIMITS.shortText,
      aliases: ["company", "company name", "organisation", "organization", "account", "agency",
                "agency / buyer", "agency/buyer", "buyer", "client", "customer", "vendor", "supplier"] }),
  T({ key: "company.website", entity: "company", field: "website", label: "Website", kind: "text",
      max: LIMITS.shortText, aliases: ["website", "url", "web", "site", "homepage"] }),
  T({ key: "company.domain", entity: "company", field: "domain", label: "Domain", kind: "text",
      max: LIMITS.shortText, aliases: ["domain", "email domain"] }),
  T({ key: "company.industry", entity: "company", field: "industry", label: "Industry", kind: "text",
      max: LIMITS.shortText, aliases: ["industry", "sector", "vertical"] }),
  T({ key: "company.location", entity: "company", field: "location", label: "Location", kind: "text",
      max: LIMITS.shortText,
      aliases: ["location", "city", "state", "region", "geography", "country", "place"] }),
  T({ key: "company.size", entity: "company", field: "size", label: "Company size", kind: "enum",
      options: COMPANY_SIZE.values, aliases: ["size", "employees", "headcount", "company size"] }),
  T({ key: "company.type", entity: "company", field: "type", label: "Company type", kind: "enum",
      options: COMPANY_TYPE.values, aliases: ["type", "company type", "account type"] }),
  T({ key: "company.relationshipStatus", entity: "company", field: "relationshipStatus",
      label: "Relationship", kind: "enum", options: RELATIONSHIP_STATUS.values,
      aliases: ["relationship", "relationship status", "account status"] }),
  T({ key: "company.leadSource", entity: "company", field: "leadSource", label: "Lead source",
      kind: "enum", options: LEAD_SOURCE.values, aliases: ["lead source", "source of lead"] }),
  T({ key: "company.description", entity: "company", field: "description", label: "Company notes",
      kind: "longtext", max: LIMITS.longText, aliases: ["about", "company notes", "description"] }),

  // ---- Contact -----------------------------------------------------------
  T({ key: "contact.fullName", entity: "contact", field: "fullName", label: "Full name", kind: "text",
      max: LIMITS.shortText,
      aliases: ["name", "full name", "contact", "contact name", "person"] }),
  T({ key: "contact.firstName", entity: "contact", field: "firstName", label: "First name",
      kind: "text", max: LIMITS.shortText, aliases: ["first name", "firstname", "given name"] }),
  T({ key: "contact.lastName", entity: "contact", field: "lastName", label: "Last name",
      kind: "text", max: LIMITS.shortText, aliases: ["last name", "lastname", "surname", "family name"] }),
  T({ key: "contact.email", entity: "contact", field: "email", label: "Email", kind: "text",
      max: LIMITS.shortText, aliases: ["email", "e-mail", "email address", "contact email"] }),
  T({ key: "contact.phone", entity: "contact", field: "phone", label: "Phone", kind: "text",
      max: LIMITS.shortText, aliases: ["phone", "telephone", "mobile", "cell", "phone number"] }),
  T({ key: "contact.jobTitle", entity: "contact", field: "jobTitle", label: "Job title", kind: "text",
      max: LIMITS.shortText, aliases: ["title", "job title", "role", "position"] }),
  T({ key: "contact.relationshipType", entity: "contact", field: "relationshipType",
      label: "Contact relationship", kind: "enum", options: RELATIONSHIP_TYPE.values,
      aliases: ["contact type", "relationship type"] }),

  // ---- Opportunity -------------------------------------------------------
  T({ key: "opportunity.name", entity: "opportunity", field: "name", label: "Opportunity title",
      kind: "text", max: LIMITS.shortText,
      aliases: ["title", "opportunity", "opportunity name", "rfp title", "solicitation title",
                "project title", "bid title", "name"] }),
  T({ key: "opportunity.solicitationNumber", entity: "opportunity", field: "solicitationNumber",
      label: "Solicitation number", kind: "text", max: LIMITS.shortText,
      aliases: ["rfp id", "rfp #", "solicitation", "solicitation number", "solicitation #",
                "bid number", "bid #", "reference", "ref", "id", "opportunity id"] }),
  T({ key: "opportunity.company", entity: "opportunity", field: "companyId", label: "Buyer / agency",
      kind: "reference", referenceTo: "company",
      aliases: ["agency", "agency / buyer", "agency/buyer", "buyer", "client", "account",
                "organisation", "organization", "company", "issuer", "customer"],
      hint: "Matched to an existing company by name, or created." }),
  T({ key: "opportunity.type", entity: "opportunity", field: "type", label: "Opportunity type",
      kind: "enum", options: OPPORTUNITY_TYPE.values,
      aliases: ["opportunity type", "solicitation type", "bid type"] }),
  T({ key: "opportunity.source", entity: "opportunity", field: "source", label: "Source",
      kind: "text", max: LIMITS.shortText,
      aliases: ["source", "found via", "channel", "origin", "sourced from"] }),
  T({ key: "opportunity.proposalDeadlineAt", entity: "opportunity", field: "proposalDeadlineAt",
      label: "Proposal deadline", kind: "date",
      aliases: ["deadline", "due", "due date", "proposal deadline", "submission deadline",
                "closes", "closing date", "response due"] }),
  T({ key: "opportunity.questionsDeadlineAt", entity: "opportunity", field: "questionsDeadlineAt",
      label: "Questions deadline", kind: "date",
      aliases: ["questions deadline", "q&a deadline", "questions due", "inquiry deadline"] }),
  T({ key: "opportunity.postedAt", entity: "opportunity", field: "postedAt", label: "Posted",
      kind: "date", aliases: ["posted", "posted at", "issued", "release date", "published"] }),
  T({ key: "opportunity.estimatedValueCents", entity: "opportunity", field: "estimatedValueCents",
      label: "Estimated value", kind: "money",
      aliases: ["value", "est. value", "estimated value", "budget", "amount", "contract value",
                "fee", "worth"] }),
  T({ key: "opportunity.submissionStatus", entity: "opportunity", field: "submissionStatus",
      label: "Submission status", kind: "enum", options: SUBMISSION_STATUS.values,
      optionAliases: {
        "sourced": "not_started", "new": "not_started", "identified": "not_started",
        "in progress": "drafting", "writing": "drafting", "in the works": "drafting",
        "bid submitted": "submitted", "sent": "submitted", "responded": "submitted",
        "awarded": "won", "not awarded": "lost", "no bid": "no_bid", "passed": "no_bid",
      },
      aliases: ["status", "submission status", "bid status", "stage"] }),
  T({ key: "opportunity.requirements", entity: "opportunity", field: "requirements",
      label: "Requirements / notes", kind: "longtext", max: LIMITS.longText,
      aliases: ["notes", "requirements", "scope", "detail", "details", "comments", "summary"] }),
  T({ key: "opportunity.proposalUrl", entity: "opportunity", field: "proposalUrl",
      label: "Proposal link", kind: "text", max: LIMITS.shortText,
      aliases: ["link", "proposal url", "solicitation link", "portal", "listing url"] }),

  // Derived. Kept as provenance, never written onto the record as current.
  T({ key: "opportunity.fitScore", entity: "opportunity", field: "fitScore", label: "Score",
      kind: "int", min: 0, max: 100, derived: true,
      aliases: ["score", "fit", "fit score", "rating", "adjusted score", "weighted score"],
      hint: "Tiny recalculates this. The spreadsheet's value is kept as source provenance." }),
  T({ key: "opportunity.verdict", entity: "opportunity", field: "__verdict", label: "Verdict",
      kind: "text", derived: true, max: LIMITS.shortText,
      aliases: ["verdict", "recommendation", "go/no-go", "go no go", "decision"],
      hint: "Tiny recalculates this from the underlying facts. Kept as source provenance." }),
  T({ key: "opportunity.daysLeft", entity: "opportunity", field: "__daysLeft", label: "Days left",
      kind: "int", derived: true,
      aliases: ["days left", "days remaining", "runway", "days to close", "time left"],
      hint: "Counted from the deadline every time it is shown, so it is never stale." }),

  // ---- Task --------------------------------------------------------------
  T({ key: "task.title", entity: "task", field: "title", label: "Next action", kind: "text",
      max: LIMITS.shortText,
      aliases: ["next action", "next step", "action", "todo", "to do", "task", "follow up",
                "follow-up", "next"] }),
  T({ key: "task.dueAt", entity: "task", field: "dueAt", label: "Action due", kind: "date",
      aliases: ["action due", "next action due", "follow up date", "task due"] }),
  T({ key: "task.priority", entity: "task", field: "priority", label: "Priority", kind: "enum",
      options: TASK_PRIORITY.values, aliases: ["priority", "urgency", "importance"] }),
];

export const TARGETS_BY_KEY = new Map(FIELD_TARGETS.map((t) => [t.key, t]));

/** Targets grouped for the mapping UI's dropdown. */
export function targetsForEntity(entity: ImportEntity): FieldTarget[] {
  return FIELD_TARGETS.filter((t) => t.entity === entity);
}
