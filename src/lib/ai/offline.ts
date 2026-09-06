import "server-only";

import type { AiProvider, CompleteOptions, CompleteResult } from "@/lib/ai/provider";

/**
 * The offline reasoning engine.
 *
 * When no model provider is configured, Tiny AI still has to answer. Rather than
 * showing empty panels or fake text, this engine answers from the structured CRM
 * context that src/lib/ai/context.ts has already assembled — which arrives with
 * the deterministic scores (momentum, health, relationship strength, risks)
 * already computed by src/lib/scoring.ts.
 *
 * So the difference between offline and model-backed is *phrasing and open-ended
 * reasoning*, not correctness: the numbers and the risk calls are identical
 * either way, because both read the same computed facts. The UI always states
 * which engine answered.
 */
export class OfflineProvider implements AiProvider {
  readonly id = "offline" as const;
  readonly model = "tiny-crm-rules-v1";

  async complete(options: CompleteOptions): Promise<CompleteResult> {
    return {
      text: answer(options),
      model: this.model,
      provider: this.id,
    };
  }

  async *stream(options: CompleteOptions): AsyncIterable<string> {
    // Chunked so the UI's streaming path is exercised identically either way.
    const text = answer(options);
    for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      yield chunk;
    }
  }
}

type Line = { raw: string; lower: string };

function answer(options: CompleteOptions): string {
  const question = options.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const context = extractContext(question);
  const q = question.toLowerCase();

  switch (options.purpose) {
    case "daily_brief":
      return dailyBrief(context);
    case "record_summary":
      return recordSummary(context);
    default:
      return generalAnswer(q, context);
  }
}

/** Splits the assembled context back into its labelled sections. */
type Sections = Record<string, Line[]>;

function extractContext(question: string): Sections {
  const marker = "CRM CONTEXT";
  const index = question.indexOf(marker);
  const body = index >= 0 ? question.slice(index + marker.length) : question;

  const sections: Sections = {};
  let current = "General";
  for (const raw of body.split("\n")) {
    const heading = raw.match(/^##\s+(.*)$/);
    if (heading) {
      current = heading[1]!.trim();
      sections[current] ??= [];
      continue;
    }
    if (raw.trim().startsWith("-")) {
      (sections[current] ??= []).push({ raw: raw.trim().replace(/^-\s*/, ""), lower: raw.toLowerCase() });
    }
  }
  return sections;
}

const get = (s: Sections, name: string) => s[name] ?? [];

function bullets(lines: Line[], max: number) {
  return lines.slice(0, max).map((l) => `- ${l.raw}`).join("\n");
}

/**
 * Context lines are dense on purpose — they are written for a model to reason
 * over. A brief is written for a person at 8am, so each line is stripped back to
 * the record and the one fact that makes it worth reading.
 */
function condense(line: string, kind: "task" | "deal" | "project" | "contact" | "opportunity" | "meeting" | "email") {
  // Context lines carry a trailing [Workspace] tag for the model's benefit; the
  // reader already knows which business they are looking at.
  const raw = line.trim().replace(/\s*\[[^\]]+\]\s*$/, "");

  switch (kind) {
    case "task": {
      // "[urgent] Title (links) — due Sep 2 ⚠ OVERDUE [Workspace]"
      const name = raw
        .replace(/^\[\w+\]\s*/, "")
        .replace(/\s*—\s*due\s[\s\S]*$/, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim();
      const overdue = /OVERDUE/i.test(raw);
      const dueToday = /due Today/i.test(raw);
      const who = raw.match(/\(([^)]+)\)/)?.[1]?.split(" / ").pop();
      const when = overdue ? "overdue" : dueToday ? "due today" : "due soon";
      return `**${name}** — ${when}${who ? ` · ${who}` : ""}`;
    }
    case "deal": {
      // "Name — $X, stage S, win ~N%, momentum M, last activity T ago, ..."
      const name = raw.replace(/\s+—\s+(?=\$)[\s\S]*$/, "").trim();
      const value = raw.match(/\$[\d,]*\d(?:\.\d+)?[KMB]?/)?.[0];
      const momentum = raw.match(/momentum (\w+)/)?.[1];
      const quiet = raw.match(/last activity ([^,]+)/)?.[1];
      const noNextStep = /No next step\./.test(raw);
      const bits = [
        momentum ? momentum : null,
        quiet ? `quiet for ${quiet.replace(" ago", "")}` : null,
        noNextStep ? "no next step" : null,
      ].filter(Boolean);
      return `**${name}**${value ? ` (${value})` : ""} — ${bits.join(", ")}`;
    }
    case "project": {
      const name = raw
        .replace(/\s+—\s+(?=[^—]*\bhealth\s)[\s\S]*$/, "")
        .replace(/\s*\([^)]*\)$/, "")
        .trim();
      const health = raw.match(/health (\w+)/)?.[1]?.replace("_", " ");
      const overdue = raw.match(/(\d+) overdue/)?.[1];
      const due = raw.match(/due ([A-Z][a-z]{2} \d+|Today|Tomorrow)/)?.[1];
      const bits = [
        health && health !== "on track" ? health : null,
        overdue ? `${overdue} overdue task${overdue === "1" ? "" : "s"}` : null,
        due ? `due ${due}` : null,
      ].filter(Boolean);
      return `**${name}** — ${bits.length ? bits.join(", ") : "needs a look"}`;
    }
    case "contact": {
      const name = raw.split(",")[0]!.split(" — ")[0]!.replace(/\s+at\s+.*/, "").trim();
      const company = raw.match(/ at ([^—]+) —/)?.[1]?.trim();
      const overdue = /follow-up OVERDUE/i.test(raw);
      const since = raw.match(/last contact ([^,]+)/)?.[1];
      const reason = overdue ? "follow-up overdue" : since ? `no contact for ${since.replace("d ago", " days")}` : "gone quiet";
      return `**${name}**${company ? ` at ${company}` : ""} — ${reason}`;
    }
    case "opportunity": {
      const name = raw
        .replace(/\s+—\s+(?=[A-Z]{2,}[,\s])[\s\S]*$/, "")
        .replace(/\s*\([^)]*\)$/, "")
        .trim();
      const deadline = raw.match(/deadline ([A-Z][a-z]{2} \d+|Today|Tomorrow)/)?.[1];
      const value = raw.match(/\$[\d,]*\d(?:\.\d+)?[KMB]?/)?.[0];
      return `**${name}** — due ${deadline ?? "soon"}${value && value !== "$0" ? ` · ${value}` : ""}`;
    }
    case "meeting": {
      const [when, ...rest] = raw.split(": ");
      return `**${when}** — ${rest.join(": ").replace(/\s*\([^)]*\)$/, "")}`;
    }
    case "email": {
      const subject = raw.match(/"([^"]+)"/)?.[1];
      const who = raw.match(/(?:to|from) ([^—]+) —/)?.[1]?.trim();
      return `**${subject ?? "A thread"}** — ${who ? `${who}, ` : ""}no reply yet`;
    }
  }
}

function briefList(lines: Line[], kind: Parameters<typeof condense>[1], max: number) {
  return lines.slice(0, max).map((l) => `- ${condense(l.raw, kind)}`).join("\n");
}

function dailyBrief(s: Sections): string {
  const tasks = get(s, "Open tasks");
  const overdueTasks = tasks.filter((t) => t.lower.includes("overdue"));
  const dueToday = tasks.filter((t) => t.lower.includes("due today"));
  const deals = get(s, "Open deals");
  const stalled = deals.filter((d) => d.lower.includes("momentum stalled"));
  const slowing = deals.filter((d) => d.lower.includes("momentum slowing"));
  const projects = get(s, "Active projects");
  const atRisk = projects.filter((p) => p.lower.includes("health at_risk") || p.lower.includes("health off_track"));
  const contacts = get(s, "Contacts needing attention");
  const opportunities = get(s, "Opportunities in flight").filter((o) => !o.lower.includes("deadline unset"));
  const unanswered = get(s, "Emails awaiting a reply");

  const headline: string[] = [];
  if (overdueTasks.length) headline.push(`${overdueTasks.length} overdue task${plural(overdueTasks.length)}`);
  if (dueToday.length) headline.push(`${dueToday.length} due today`);
  if (stalled.length) headline.push(`${stalled.length} stalled deal${plural(stalled.length)}`);
  if (atRisk.length) headline.push(`${atRisk.length} project${plural(atRisk.length)} slipping`);
  if (contacts.length) headline.push(`${contacts.length} contact${plural(contacts.length)} gone quiet`);
  if (opportunities.length) headline.push(`${opportunities.length} deadline${plural(opportunities.length)} ahead`);
  if (unanswered.length) headline.push(`${unanswered.length} email${plural(unanswered.length)} awaiting a reply`);

  const parts: string[] = [];
  parts.push(
    headline.length
      ? `${joinList(headline).replace(/^./, (c) => c.toUpperCase())}.`
      : "Nothing is overdue and no deal has gone quiet. A good day to work ahead.",
  );

  // Only the sections that actually have something, and only a few lines each —
  // a brief that lists everything is just the database again.
  if (overdueTasks.length || dueToday.length) {
    parts.push(`\n**Do first**\n${briefList([...overdueTasks, ...dueToday], "task", 3)}`);
  }
  if (stalled.length || slowing.length) {
    parts.push(`\n**Deals losing momentum**\n${briefList([...stalled, ...slowing], "deal", 2)}`);
  }
  if (atRisk.length) {
    parts.push(`\n**Projects slipping**\n${briefList(atRisk, "project", 2)}`);
  }
  if (contacts.length) {
    parts.push(`\n**Worth a message**\n${briefList(contacts, "contact", 2)}`);
  }
  // Deadlines, meetings, follow-ups and unanswered email each have their own
  // panel on the dashboard. Repeating them here would make the brief a second
  // copy of the page rather than a summary of it — the headline already counts
  // them, so the body stays on what to actually do first.

  const first = overdueTasks[0] ?? dueToday[0] ?? stalled[0] ?? contacts[0];
  if (first) {
    const kind = overdueTasks[0] || dueToday[0] ? "task" : stalled[0] ? "deal" : "contact";
    parts.push(`\n**Start here** — ${condense(first.raw, kind as "task")}`);
  }

  return parts.join("\n");
}

function recordSummary(s: Sections): string {
  const record = get(s, "Record");
  const timeline = get(s, "Timeline");
  const tasks = get(s, "Tasks");
  const notes = get(s, "Notes");
  const openTasks = tasks.filter((t) => t.lower.includes("[open]") || t.lower.includes("[in_progress]"));
  const overdue = tasks.filter((t) => t.lower.includes("overdue"));

  const parts: string[] = [];

  if (record.length) parts.push(record.map((r) => r.raw).join(" · "));

  if (timeline.length) {
    const meetings = timeline.filter((t) => t.lower.includes("[meeting")).length;
    const calls = timeline.filter((t) => t.lower.includes("[call")).length;
    const emails = timeline.filter((t) => t.lower.includes("[email")).length;
    const mix = [
      meetings ? `${meetings} meeting${plural(meetings)}` : null,
      calls ? `${calls} call${plural(calls)}` : null,
      emails ? `${emails} email${plural(emails)}` : null,
    ].filter(Boolean);
    parts.push(
      `\n**History** — ${timeline.length} logged interaction${plural(timeline.length)}${mix.length ? ` (${joinList(mix as string[])})` : ""}. Most recent: ${timeline[0]!.raw}`,
    );
  } else {
    parts.push("\n**History** — nothing has been logged here yet.");
  }

  if (notes.length) {
    parts.push(`\n**What the notes say**\n${bullets(notes, 2)}`);
  }

  if (openTasks.length) {
    parts.push(`\n**Open work**\n${bullets(openTasks, 4)}`);
  }

  const next =
    overdue.length > 0
      ? `Clear the overdue item first: ${overdue[0]!.raw}`
      : openTasks.length > 0
        ? `Keep moving on: ${openTasks[0]!.raw}`
        : timeline.length === 0
          ? "Log the last conversation so this record has a history to reason about."
          : "Set a next step — there is nothing scheduled to move this forward.";

  parts.push(`\n**Suggested next step** — ${next}`);
  return parts.join("\n");
}

function generalAnswer(q: string, s: Sections): string {
  const matchers: { test: RegExp; section: string; empty: string; lead: (n: number) => string }[] = [
    {
      test: /today|now|right now|priorit|focus|do first|what should i/,
      section: "Open tasks",
      empty: "Nothing is due — you are clear today.",
      lead: (n) => `You have ${n} open task${plural(n)}. In order of urgency:`,
    },
    {
      test: /deal|pipeline|revenue|close|closing|sales|forecast/,
      section: "Open deals",
      empty: "There are no open deals in this scope.",
      lead: (n) => `${n} open deal${plural(n)}, highest value first:`,
    },
    {
      test: /project|at risk|delivery|initiative/,
      section: "Active projects",
      empty: "No active projects in this scope.",
      lead: (n) => `${n} active project${plural(n)}:`,
    },
    {
      test: /contact|talk|reach|follow[ -]?up|relationship|haven'?t|person|people|quiet|cold/,
      section: "Contacts needing attention",
      empty: "Everyone is up to date — no overdue follow-ups.",
      lead: (n) => `${n} contact${plural(n)} need attention:`,
    },
    {
      test: /opportunit|rfp|proposal|solicitation|grant|bid|deadline/,
      section: "Opportunities in flight",
      empty: "No opportunities are in flight.",
      lead: (n) => `${n} opportunit${n === 1 ? "y" : "ies"} in flight, nearest deadline first:`,
    },
    {
      test: /meeting|calendar|schedule|week/,
      section: "Meetings in the next 7 days",
      empty: "Nothing on the calendar in the next seven days.",
      lead: (n) => `${n} meeting${plural(n)} in the next seven days:`,
    },
    {
      test: /email|unanswered|reply|inbox|message/,
      section: "Emails awaiting a reply",
      empty: "No threads are waiting on a reply.",
      lead: (n) => `${n} thread${plural(n)} awaiting a reply:`,
    },
    {
      test: /happened|recent|last week|activity|update/,
      section: "Recent activity",
      empty: "Nothing has been logged recently.",
      lead: (n) => `The last ${n} thing${plural(n)} that happened:`,
    },
  ];

  for (const m of matchers) {
    if (m.test.test(q)) {
      const lines = get(s, m.section);
      if (lines.length === 0) return m.empty;
      return `${m.lead(lines.length)}\n\n${bullets(lines, 8)}${trailer(m.section, lines)}`;
    }
  }

  // Free-text search across every section, so "summarize everything with BBOP"
  // still finds the right records.
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 3 && !STOPWORDS.has(t));
  if (terms.length) {
    const hits: string[] = [];
    for (const [name, lines] of Object.entries(s)) {
      const matched = lines.filter((l) => terms.some((t) => l.lower.includes(t)));
      if (matched.length) hits.push(`**${name}**\n${bullets(matched, 5)}`);
    }
    if (hits.length) {
      return `Here is everything I have on that:\n\n${hits.join("\n\n")}`;
    }
  }

  const overview = Object.entries(s)
    .filter(([, lines]) => lines.length > 0)
    .map(([name, lines]) => `- **${name}**: ${lines.length}`)
    .join("\n");

  return [
    "I did not find a direct match for that. Here is what is currently in scope:",
    "",
    overview || "Nothing yet — start by adding a contact or a project.",
    "",
    "Try asking about today's tasks, deals that need attention, projects at risk, or who has gone quiet.",
  ].join("\n");
}

function trailer(section: string, lines: Line[]) {
  const overdue = lines.filter((l) => l.lower.includes("overdue"));
  const stalled = lines.filter((l) => l.lower.includes("momentum stalled"));
  const risky = lines.filter((l) => l.lower.includes("health off_track") || l.lower.includes("health at_risk"));

  if (section === "Open tasks" && overdue.length) {
    return `\n\n${overdue.length} of these ${overdue.length === 1 ? "is" : "are"} already overdue — start there.`;
  }
  if (section === "Open deals" && stalled.length) {
    return `\n\n${stalled.length} ${stalled.length === 1 ? "has" : "have"} stalled. A stalled deal needs a specific, dated next step rather than another check-in.`;
  }
  if (section === "Active projects" && risky.length) {
    return `\n\n${risky.length} ${risky.length === 1 ? "is" : "are"} off track. The usual cause is an overdue task or a deadline that passed without being re-forecast.`;
  }
  return "";
}

const STOPWORDS = new Set([
  "what", "when", "where", "which", "with", "that", "this", "have", "haven", "should",
  "about", "everything", "happening", "there", "their", "from", "into", "does", "show",
  "tell", "give", "list", "need", "want", "know", "help", "please", "summarize", "summarise",
]);

const plural = (n: number) => (n === 1 ? "" : "s");

function joinList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
