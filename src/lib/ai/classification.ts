import "server-only";

import { db } from "@/lib/db";
import { getProvider, isModelBacked } from "@/lib/ai/provider";
import { SYSTEM_PROMPTS } from "@/lib/ai/prompts";
import { parseJson } from "@/lib/json";
import { assertWithinLimit, recordUsage } from "@/lib/entitlements";
import type { Actor } from "@/lib/auth/access";

/**
 * Auto-categorisation.
 *
 * Paste "Talked to Sarah at Fuller. The provost is interested and wants a demo
 * next month" and this produces a reviewable set of proposed CRM changes.
 *
 * Nothing here writes to the database. The caller shows the proposals, the user
 * approves them, and only then does src/lib/actions run. That separation is
 * deliberate: the product never silently edits the CRM.
 */

export type Proposal = {
  id: string;
  kind: "contact" | "company" | "opportunity" | "task" | "note" | "date";
  label: string;
  detail?: string;
  /** An existing record this matches, when one was found. */
  matchId?: string;
  matchLabel?: string;
  isNew: boolean;
  payload: Record<string, unknown>;
};

export type ClassificationResult = {
  summary: string;
  sentiment: "positive" | "neutral" | "negative";
  proposals: Proposal[];
  modelBacked: boolean;
};

type RawExtraction = {
  summary?: string;
  sentiment?: string;
  contacts?: { name: string; company?: string | null; title?: string | null; isNew?: boolean }[];
  companies?: { name: string; isNew?: boolean }[];
  opportunities?: { name: string; value?: number | null; note?: string | null }[];
  tasks?: { title: string; dueInDays?: number | null; priority?: string }[];
  dates?: { label: string; inDays?: number | null }[];
};

export async function classifyText(
  actor: Actor,
  workspaceIds: string[],
  text: string,
): Promise<ClassificationResult> {
  const raw = isModelBacked()
    ? await extractWithModel(actor, text)
    : extractHeuristically(text);

  const proposals: Proposal[] = [];
  let counter = 0;
  const nextId = () => `p${counter++}`;

  // Match against existing records so the user is offered "link" rather than
  // "create a duplicate".
  for (const c of raw.companies ?? []) {
    const existing = await db.company.findFirst({
      where: { workspaceId: { in: workspaceIds }, name: { contains: c.name } },
      select: { id: true, name: true },
    });
    proposals.push({
      id: nextId(),
      kind: "company",
      label: existing ? `Link to ${existing.name}` : `Create company “${c.name}”`,
      matchId: existing?.id,
      matchLabel: existing?.name,
      isNew: !existing,
      payload: { name: c.name },
    });
  }

  for (const c of raw.contacts ?? []) {
    const existing = await db.contact.findFirst({
      where: { workspaceId: { in: workspaceIds }, fullName: { contains: c.name } },
      select: { id: true, fullName: true, company: { select: { name: true } } },
    });
    const company = c.company
      ? await db.company.findFirst({
          where: { workspaceId: { in: workspaceIds }, name: { contains: c.company } },
          select: { id: true, name: true },
        })
      : null;

    proposals.push({
      id: nextId(),
      kind: "contact",
      label: existing ? `Link to ${existing.fullName}` : `Create contact “${c.name}”`,
      detail: [c.title, c.company].filter(Boolean).join(" · ") || undefined,
      matchId: existing?.id,
      matchLabel: existing?.fullName,
      isNew: !existing,
      payload: {
        name: c.name,
        firstName: c.name.split(" ")[0],
        lastName: c.name.split(" ").slice(1).join(" "),
        jobTitle: c.title ?? null,
        companyId: company?.id ?? null,
        companyName: c.company ?? null,
      },
    });
  }

  for (const o of raw.opportunities ?? []) {
    proposals.push({
      id: nextId(),
      kind: "opportunity",
      label: `Track opportunity “${o.name}”`,
      detail: o.note ?? undefined,
      isNew: true,
      payload: { name: o.name, value: o.value ?? null },
    });
  }

  for (const t of raw.tasks ?? []) {
    proposals.push({
      id: nextId(),
      kind: "task",
      label: `Task: ${t.title}`,
      detail: t.dueInDays != null ? `Due in ${t.dueInDays} day${t.dueInDays === 1 ? "" : "s"}` : undefined,
      isNew: true,
      payload: { title: t.title, dueInDays: t.dueInDays ?? null, priority: t.priority ?? "medium" },
    });
  }

  for (const d of raw.dates ?? []) {
    proposals.push({
      id: nextId(),
      kind: "date",
      label: d.label,
      detail: d.inDays != null ? `About ${d.inDays} days out` : "No specific date",
      isNew: true,
      payload: { label: d.label, inDays: d.inDays ?? null },
    });
  }

  return {
    summary: raw.summary ?? text.slice(0, 200),
    sentiment: (raw.sentiment as ClassificationResult["sentiment"]) ?? "neutral",
    proposals,
    modelBacked: isModelBacked(),
  };
}

async function extractWithModel(actor: Actor, text: string): Promise<RawExtraction> {
  await assertWithinLimit(actor, "aiRequestsPerMonth");
  const provider = getProvider();
  const result = await provider.complete({
    purpose: "classification",
    system: SYSTEM_PROMPTS.classify,
    effort: "low",
    maxTokens: 1400,
    messages: [{ role: "user", content: text }],
  });
  await recordUsage(actor.identity.id, "ai_requests");

  // Models occasionally wrap JSON in a fence despite instructions.
  const cleaned = result.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return parseJson<RawExtraction>(cleaned, {});
}

/**
 * Pattern-based extraction used when no model is configured. Conservative by
 * design: it would rather miss an entity than invent one.
 */
function extractHeuristically(text: string): RawExtraction {
  const raw: RawExtraction = { contacts: [], companies: [], opportunities: [], tasks: [], dates: [] };

  // "Talked to Sarah at Fuller" / "Met with Dr. James Okafor from BBOP Center"
  const personPattern =
    /\b(?:talked to|spoke (?:to|with)|met (?:with)?|call(?:ed)? with|heard from|emailed)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:\s+(?:at|from|with)\s+([A-Z][A-Za-z&.'-]*(?:\s+[A-Z][A-Za-z&.'-]*){0,3}))?/g;
  for (const match of text.matchAll(personPattern)) {
    raw.contacts!.push({ name: match[1]!, company: match[2] ?? null, title: null, isNew: true });
    if (match[2]) raw.companies!.push({ name: match[2], isNew: true });
  }

  const titlePattern = /\b(provost|dean|director|president|cio|cto|ceo|coo|vp|manager|chair|partner|founder)\b/gi;
  const titles = Array.from(text.matchAll(titlePattern)).map((m) => m[1]!);
  if (titles.length && raw.contacts!.length === 0) {
    raw.contacts!.push({ name: capitalise(titles[0]!), company: null, title: capitalise(titles[0]!), isNew: true });
  }

  // Intent phrases become tasks.
  const intents: { pattern: RegExp; title: (m: RegExpMatchArray) => string; days: number | null }[] = [
    { pattern: /\bwants? a demo\b/i, title: () => "Schedule a demo", days: 14 },
    { pattern: /\bsend (?:over |them )?(?:the |a )?([a-z ]{3,40})/i, title: (m) => `Send ${m[1]!.trim()}`, days: 3 },
    { pattern: /\bfollow(?:[ -])?up\b/i, title: () => "Follow up", days: 5 },
    { pattern: /\bschedule (?:a |the )?([a-z ]{3,30})/i, title: (m) => `Schedule ${m[1]!.trim()}`, days: 7 },
    { pattern: /\b(?:needs?|wants?) (?:a |an |the )?(proposal|quote|pricing|contract|sow)\b/i, title: (m) => `Prepare the ${m[1]!.toLowerCase()}`, days: 5 },
  ];
  for (const intent of intents) {
    const match = text.match(intent.pattern);
    if (match) raw.tasks!.push({ title: intent.title(match), dueInDays: intent.days, priority: "medium" });
  }

  const timePattern = /\b(next (?:week|month|quarter)|this (?:week|month)|in (\d+) (?:days?|weeks?|months?)|by (?:friday|monday|the end of the month))\b/gi;
  for (const match of text.matchAll(timePattern)) {
    raw.dates!.push({ label: match[1]!, inDays: approximateDays(match[1]!) });
  }

  const positive = /\b(interested|excited|great|positive|keen|loved|impressed|yes|approved|go ahead)\b/i.test(text);
  const negative = /\b(concerned|worried|delay|pushed back|budget cut|no longer|declined|lost|frustrated)\b/i.test(text);

  raw.summary = text.trim().split(/(?<=[.!?])\s/)[0]?.slice(0, 200) ?? text.slice(0, 200);
  raw.sentiment = negative ? "negative" : positive ? "positive" : "neutral";

  // De-duplicate names picked up by more than one pattern.
  raw.contacts = dedupeBy(raw.contacts!, (c) => c.name.toLowerCase());
  raw.companies = dedupeBy(raw.companies!, (c) => c.name.toLowerCase());
  raw.tasks = dedupeBy(raw.tasks!, (t) => t.title.toLowerCase());
  raw.dates = dedupeBy(raw.dates!, (d) => d.label.toLowerCase());

  return raw;
}

function approximateDays(phrase: string): number | null {
  const lower = phrase.toLowerCase();
  if (lower.includes("next week")) return 7;
  if (lower.includes("this week")) return 3;
  if (lower.includes("next month")) return 30;
  if (lower.includes("this month")) return 14;
  if (lower.includes("next quarter")) return 90;
  const n = lower.match(/in (\d+) (days?|weeks?|months?)/);
  if (n) {
    const value = Number(n[1]);
    if (n[2]!.startsWith("day")) return value;
    if (n[2]!.startsWith("week")) return value * 7;
    return value * 30;
  }
  if (lower.includes("friday")) return 5;
  if (lower.includes("monday")) return 3;
  if (lower.includes("end of the month")) return 20;
  return null;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function capitalise(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
