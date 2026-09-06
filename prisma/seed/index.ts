// Imported first, for its side effect: it exits before the Prisma client is
// constructed if this does not look like a development database.
import "./guard-destructive";

import bcrypt from "bcryptjs";

import { db, NOW, daysAgo, daysAhead, dollars, randInt } from "./helpers";
import { COMPANIES, CONTACTS, TAGS, WORKSPACES } from "./data";
import {
  DEFAULT_DEAL_STAGES,
  DEFAULT_OPPORTUNITY_STAGES,
  DEFAULT_PROJECT_STATUSES,
} from "../../src/lib/enums";

type Id = string;
const ws: Record<string, Id> = {};
const companyId: Record<string, Id> = {};
const contactId: Record<string, Id> = {};
const statusId: Record<string, Record<string, Id>> = {};
const dealStageId: Record<string, Record<string, Id>> = {};
const oppStageId: Record<string, Record<string, Id>> = {};
const dealPipelineId: Record<string, Id> = {};
const oppPipelineId: Record<string, Id> = {};
const tagId: Record<string, Record<string, Id>> = {};
const projectId: Record<string, Id> = {};
const dealId: Record<string, Id> = {};
const oppId: Record<string, Id> = {};

let userId = "";

/** Every activity written also advances the parent record's lastActivityAt. */
type ActivityInput = {
  workspace: string;
  type: string;
  title: string;
  body?: string;
  direction?: "inbound" | "outbound" | "internal";
  daysAgo: number;
  hour?: number;
  durationMin?: number;
  contact?: string;
  company?: string;
  deal?: string;
  project?: string;
  opportunity?: string;
  meta?: Record<string, unknown>;
};

/** Extra activities generated while seeding, merged with the scripted ones. */
const activityQueue: ActivityInput[] = [];

async function reset() {
  // Order matters only for databases without cascade support; Prisma issues
  // deletes per model, so start at the leaves.
  const models = [
    "eventAttendee", "calendarEvent", "emailMessage", "integration",
    "aiMessage", "aiThread", "notification", "aiInsight",
    "automationRun", "automation", "savedView",
    "customFieldValue", "customFieldDef", "tagLink", "tag",
    "fileAsset", "activity", "note", "task",
    "opportunityContact", "opportunity", "dealContact", "deal",
    "milestone", "projectContact", "project",
    "pipelineStage", "pipeline", "projectStatus",
    "contact", "company", "usageCounter", "workspaceMember", "workspace", "user",
  ] as const;
  for (const model of models) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)[model].deleteMany({});
  }
}

async function seedUserAndWorkspaces() {
  const passwordHash = await bcrypt.hash("tinycrm", 10);

  const user = await db.user.create({
    data: {
      email: "owner@tinycrm.app",
      name: "Bris Whitaker",
      jobTitle: "Founder",
      passwordHash,
      plan: "lifetime",
      onboardedAt: daysAgo(240),
      lastSeenAt: NOW,
      createdAt: daysAgo(240),
    },
  });
  userId = user.id;

  // A second account on the free plan, so limit behaviour is demonstrable.
  await db.user.create({
    data: {
      email: "demo@tinycrm.app",
      name: "Demo User",
      passwordHash: await bcrypt.hash("tinycrm", 10),
      plan: "free",
      createdAt: daysAgo(2),
    },
  });

  for (const w of WORKSPACES) {
    const created = await db.workspace.create({
      data: {
        name: w.name,
        slug: w.slug,
        color: w.color,
        description: w.description,
        ownerId: userId,
        createdAt: daysAgo(240),
        members: { create: { userId, role: "owner", createdAt: daysAgo(240) } },
      },
    });
    ws[w.key] = created.id;

    statusId[w.key] = {};
    for (const [i, s] of DEFAULT_PROJECT_STATUSES.entries()) {
      const st = await db.projectStatus.create({
        data: {
          workspaceId: created.id,
          key: s.key,
          name: s.name,
          color: s.color,
          order: i,
          isTerminal: s.isTerminal,
          isDefault: "isDefault" in s ? Boolean(s.isDefault) : false,
        },
      });
      statusId[w.key]![s.key] = st.id;
    }

    const dealPipeline = await db.pipeline.create({
      data: {
        workspaceId: created.id,
        name: "Sales",
        kind: "deal",
        isDefault: true,
        order: 0,
        description: "The default pipeline for new business.",
      },
    });
    dealPipelineId[w.key] = dealPipeline.id;
    dealStageId[w.key] = {};
    for (const [i, s] of DEFAULT_DEAL_STAGES.entries()) {
      const stage = await db.pipelineStage.create({
        data: { pipelineId: dealPipeline.id, name: s.name, order: i, probability: s.probability, color: s.color, kind: s.kind },
      });
      dealStageId[w.key]![s.name] = stage.id;
    }

    const oppPipeline = await db.pipeline.create({
      data: {
        workspaceId: created.id,
        name: w.key === "ai" ? "RFP Opportunities" : "Opportunities",
        kind: "opportunity",
        isDefault: true,
        order: 1,
        description: "Formal solicitations, grants and partnership openings.",
      },
    });
    oppPipelineId[w.key] = oppPipeline.id;
    oppStageId[w.key] = {};
    for (const [i, s] of DEFAULT_OPPORTUNITY_STAGES.entries()) {
      const stage = await db.pipelineStage.create({
        data: { pipelineId: oppPipeline.id, name: s.name, order: i, probability: s.probability, color: s.color, kind: s.kind },
      });
      oppStageId[w.key]![s.name] = stage.id;
    }

    tagId[w.key] = {};
    for (const name of TAGS) {
      const tag = await db.tag.create({
        data: { workspaceId: created.id, name, color: tagColor(name) },
      });
      tagId[w.key]![name] = tag.id;
    }
  }

  // A second pipeline in the business-development workspace, to show that
  // multiple pipelines per workspace are real rather than theoretical.
  const investorPipeline = await db.pipeline.create({
    data: { workspaceId: ws.bizdev!, name: "Investors", kind: "deal", order: 2, description: "Fundraising conversations." },
  });
  const investorStages = ["Intro", "First Meeting", "Diligence", "Term Sheet", "Committed", "Passed"];
  const investorStageIds: Record<string, string> = {};
  for (const [i, name] of investorStages.entries()) {
    const kind = name === "Committed" ? "won" : name === "Passed" ? "lost" : "open";
    const stage = await db.pipelineStage.create({
      data: {
        pipelineId: investorPipeline.id,
        name,
        order: i,
        probability: [10, 30, 55, 80, 100, 0][i]!,
        color: ["#94a3b8", "#38bdf8", "#818cf8", "#f59e0b", "#068C28", "#f43f5e"][i]!,
        kind,
      },
    });
    investorStageIds[name] = stage.id;
  }
  return { investorPipeline, investorStageIds };
}

function tagColor(name: string) {
  const map: Record<string, string> = {
    "Higher Education": "#2563EB", Government: "#0F766E", Investor: "#CA8A04",
    Partner: "#7C3AED", Client: "#068C28", Prospect: "#0891B2", "Warm Lead": "#EA580C",
    Strategic: "#DB2777", RFP: "#7C3AED", AI: "#068C28", Education: "#2563EB",
    "San Diego": "#0891B2", Nonprofit: "#0F766E", Referral: "#3DBE46",
    Renewal: "#068C28", Champion: "#CA8A04", "Decision Maker": "#DB2777", "Budget Holder": "#EA580C",
  };
  return map[name] ?? "#6b6b66";
}

async function linkTags(workspace: string, entityType: string, entityId: string, names: string[] = []) {
  for (const name of names) {
    const tag = tagId[workspace]?.[name];
    if (!tag) continue;
    await db.tagLink.create({
      data: { workspaceId: ws[workspace]!, tagId: tag, entityType, entityId },
    });
  }
}

async function seedAccounts() {
  for (const c of COMPANIES) {
    const created = await db.company.create({
      data: {
        workspaceId: ws[c.workspace]!,
        name: c.name,
        domain: c.domain,
        industry: c.industry,
        website: c.website,
        size: c.size,
        location: c.location,
        revenueRange: c.revenueRange,
        type: c.type,
        leadSource: c.leadSource,
        relationshipStatus: c.relationshipStatus ?? "prospect",
        description: c.description,
        ownerId: userId,
        createdAt: daysAgo(randInt(60, 220)),
      },
    });
    companyId[c.key] = created.id;
    await linkTags(c.workspace, "company", created.id, c.tags);
  }

  for (const c of CONTACTS) {
    const created = await db.contact.create({
      data: {
        workspaceId: ws[c.workspace]!,
        firstName: c.first,
        lastName: c.last,
        fullName: `${c.first} ${c.last}`,
        jobTitle: c.title,
        companyId: c.company ? companyId[c.company] : null,
        email: c.email,
        phone: c.phone,
        linkedin: c.linkedin,
        location: c.location,
        relationshipType: c.relationshipType ?? "prospect",
        leadSource: c.leadSource,
        ownerId: userId,
        importance: c.importance,
        lastContactedAt: c.lastContactDays !== undefined ? daysAgo(c.lastContactDays) : null,
        nextFollowUpAt: c.followUpDays !== undefined ? daysAhead(c.followUpDays) : null,
        createdAt: daysAgo(randInt(40, 200)),
      },
    });
    contactId[c.key] = created.id;
    await linkTags(c.workspace, "contact", created.id, c.tags);
  }

  // Primary contacts.
  const primaries: [string, string][] = [
    ["fuller", "sarah"], ["sjsu", "marcus"], ["jessup", "tom"], ["apu", "apucio"],
    ["biola", "biolaprov"], ["csulb", "csulbproc"], ["bbop", "james"], ["harbor", "harbormk"],
    ["seaside", "seaside1"], ["meridian", "meridian1"], ["verdegrocers", "verde1"],
    ["fieldnotes", "fieldnotes1"], ["northgate", "northgate1"], ["cascade", "cascade1"],
    ["tidewater", "tidewater1"], ["lattice", "lattice1"],
  ];
  for (const [company, contact] of primaries) {
    await db.company.update({
      where: { id: companyId[company]! },
      data: { primaryContactId: contactId[contact]! },
    });
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

type SeedProject = {
  key: string;
  workspace: string;
  name: string;
  company?: string;
  status: string;
  type: string;
  priority: string;
  description: string;
  startAgo: number;
  targetIn: number;
  budget?: number;
  revenue?: number;
  nextAction?: string;
  nextActionIn?: number;
  contacts: string[];
  milestones: { name: string; dueIn: number; done?: boolean }[];
  lastActivityDays: number;
};

const PROJECTS: SeedProject[] = [
  {
    key: "bbop", workspace: "digital", name: "BBOP Website Redesign", company: "bbop",
    status: "active", type: "website", priority: "high",
    description:
      "Full rebuild of bbopcenter.org: new information architecture, program finder, donor portal and a CMS the comms team can actually run themselves.",
    startAgo: 62, targetIn: 24, budget: 68000, revenue: 68000,
    nextAction: "Send the revised donor portal wireframes to James for board review",
    nextActionIn: 2,
    contacts: ["james", "bbopcomms", "bbopboard"],
    milestones: [
      { name: "Discovery & content audit", dueIn: -44, done: true },
      { name: "Information architecture sign-off", dueIn: -26, done: true },
      { name: "Design system & key templates", dueIn: -6, done: true },
      { name: "Donor portal build", dueIn: 9 },
      { name: "Content migration", dueIn: 17 },
      { name: "Launch", dueIn: 24 },
    ],
    lastActivityDays: 1,
  },
  {
    key: "plp", workspace: "ai", name: "Predictive Learning Platform", company: "fuller",
    status: "active", type: "software", priority: "urgent",
    description:
      "A retention model and advisor dashboard for Fuller. Ingests SIS and LMS data, flags at-risk students weekly, and routes them to the right advisor.",
    startAgo: 96, targetIn: 41, budget: 185000, revenue: 185000,
    nextAction: "Confirm the FERPA data-sharing addendum with Priya before the model refresh",
    nextActionIn: 4,
    contacts: ["sarah", "provost", "fullerit"],
    milestones: [
      { name: "Data access & FERPA review", dueIn: -70, done: true },
      { name: "Baseline retention model", dueIn: -40, done: true },
      { name: "Advisor dashboard v1", dueIn: -8, done: true },
      { name: "Pilot with 3 advising cohorts", dueIn: 12 },
      { name: "Model validation report", dueIn: 27 },
      { name: "Full rollout", dueIn: 41 },
    ],
    lastActivityDays: 2,
  },
  {
    key: "fulleroutreach", workspace: "ai", name: "Fuller University Outreach", company: "fuller",
    status: "waiting", type: "consulting", priority: "medium",
    description:
      "Expansion track: take the retention work to the wider Fuller network and the seminary consortium. Currently waiting on the Provost's budget decision.",
    startAgo: 38, targetIn: 55, budget: 45000,
    nextAction: "Follow up with Provost Okonkwo — the budget answer is now 3 days late",
    nextActionIn: -3,
    contacts: ["provost", "sarah", "advisor1"],
    milestones: [
      { name: "Consortium interest survey", dueIn: -20, done: true },
      { name: "Provost budget decision", dueIn: -3 },
      { name: "Consortium kickoff", dueIn: 30 },
    ],
    lastActivityDays: 16,
  },
  {
    key: "sjsu", workspace: "ai", name: "SJSU Opportunity", company: "sjsu",
    status: "proposal", type: "consulting", priority: "high",
    description:
      "Response to the SJSU student success analytics solicitation. Proposal is drafted; the technical narrative and pricing still need a pass.",
    startAgo: 21, targetIn: 9, budget: 240000,
    nextAction: "Finish the technical narrative — questions deadline is in 2 days",
    nextActionIn: 2,
    contacts: ["marcus", "sjsuproc"],
    milestones: [
      { name: "Go / no-go decision", dueIn: -14, done: true },
      { name: "Questions submitted", dueIn: 2 },
      { name: "Proposal submitted", dueIn: 9 },
    ],
    lastActivityDays: 3,
  },
  {
    key: "dropqlaunch", workspace: "dropq", name: "DropQ Launch", company: "fieldnotes",
    status: "active", type: "software", priority: "urgent",
    description:
      "Get DropQ from 4 pilot stores to general availability: billing, self-serve onboarding, store dashboard and a public marketing site.",
    startAgo: 74, targetIn: 33, budget: 90000, revenue: 24000,
    nextAction: "Ship self-serve onboarding so Verde can pilot without hand-holding",
    nextActionIn: 6,
    contacts: ["fieldnotes1", "fieldnotes2"],
    milestones: [
      { name: "Pilot in 4 Fieldnotes stores", dueIn: -30, done: true },
      { name: "Billing & subscriptions", dueIn: -5, done: true },
      { name: "Self-serve onboarding", dueIn: 6 },
      { name: "Store operator dashboard", dueIn: 18 },
      { name: "Public launch", dueIn: 33 },
    ],
    lastActivityDays: 1,
  },
  {
    key: "jessupadvising", workspace: "ai", name: "Jessup Advising Redesign", company: "jessup",
    status: "active", type: "consulting", priority: "medium",
    description:
      "Rework the advising workflow around the enrollment audit findings. Process design plus a lightweight caseload dashboard.",
    startAgo: 45, targetIn: 30, budget: 52000, revenue: 52000,
    nextAction: "Run the advisor workshop and capture the caseload rules",
    nextActionIn: 8,
    contacts: ["tom", "jessupdata"],
    milestones: [
      { name: "Enrollment audit delivered", dueIn: -25, done: true },
      { name: "Advisor workshop", dueIn: 8 },
      { name: "Caseload dashboard", dueIn: 22 },
      { name: "Handover", dueIn: 30 },
    ],
    lastActivityDays: 4,
  },
  {
    key: "harborretainer", workspace: "digital", name: "Harbor Health Retainer", company: "harbor",
    status: "active", type: "retainer", priority: "medium",
    description: "Ongoing monthly retainer: campaign landing pages, patient communications and site maintenance.",
    startAgo: 190, targetIn: 60, budget: 4500, revenue: 31500,
    nextAction: "Scope the Q4 open-enrollment campaign pages",
    nextActionIn: 11,
    contacts: ["harbormk", "harborops"],
    milestones: [
      { name: "Q2 campaign", dueIn: -60, done: true },
      { name: "Q3 campaign", dueIn: -8, done: true },
      { name: "Q4 open enrollment", dueIn: 40 },
    ],
    lastActivityDays: 8,
  },
  {
    key: "seasidesite", workspace: "digital", name: "Seaside Collective Site Refresh", company: "seaside",
    status: "proposal", type: "website", priority: "medium",
    description: "Booking-first refresh across four restaurant sites, targeted at the summer season.",
    startAgo: 12, targetIn: 20, budget: 34000,
    nextAction: "Send the proposal with two scope options",
    nextActionIn: 3,
    contacts: ["seaside1"],
    milestones: [{ name: "Proposal sent", dueIn: 3 }, { name: "Decision", dueIn: 14 }],
    lastActivityDays: 5,
  },
  {
    key: "meridiansite", workspace: "digital", name: "Meridian Housing Rebuild", company: "meridian",
    status: "discovery", type: "website", priority: "low",
    description: "Grant-funded site rebuild. Committee decision process, slow but real budget.",
    startAgo: 30, targetIn: 75, budget: 41000,
    contacts: ["meridian1"],
    milestones: [{ name: "Stakeholder interviews", dueIn: 10 }, { name: "Proposal", dueIn: 28 }],
    lastActivityDays: 22,
  },
  {
    key: "verdepilot", workspace: "dropq", name: "Verde Grocers Pilot", company: "verdegrocers",
    status: "waiting", type: "software", priority: "high",
    description: "Three-store curbside pilot at Verde. Waiting on their IT security review before we can schedule.",
    startAgo: 34, targetIn: 26, budget: 30000,
    nextAction: "Chase Roy on the security questionnaire — nothing back for 26 days",
    nextActionIn: -2,
    contacts: ["verde1", "verde2"],
    milestones: [
      { name: "Security review", dueIn: -2 },
      { name: "Store install", dueIn: 14 },
      { name: "Pilot readout", dueIn: 26 },
    ],
    lastActivityDays: 26,
  },
  {
    key: "seedround", workspace: "bizdev", name: "DropQ Seed Round", status: "active",
    type: "partnership", priority: "high",
    description: "Raise a $1.5M seed to fund the DropQ go-to-market. Cascade is the lead candidate.",
    startAgo: 52, targetIn: 70, budget: 1500000,
    nextAction: "Send Cascade the updated metrics memo ahead of partner meeting",
    nextActionIn: 4,
    contacts: ["cascade1", "cascade2", "tidewater1", "mentor1"],
    milestones: [
      { name: "Deck & data room", dueIn: -30, done: true },
      { name: "First partner meetings", dueIn: -6, done: true },
      { name: "Lead commitment", dueIn: 35 },
      { name: "Close", dueIn: 70 },
    ],
    lastActivityDays: 7,
  },
  {
    key: "latticepartner", workspace: "bizdev", name: "Lattice Reseller Agreement", company: "lattice",
    status: "discovery", type: "partnership", priority: "medium",
    description: "Explore a referral or reseller arrangement for the higher-ed analytics practice.",
    startAgo: 25, targetIn: 45, budget: 0,
    nextAction: "Draft the referral economics before the next call",
    nextActionIn: 9,
    contacts: ["lattice1"],
    milestones: [{ name: "Commercial terms outline", dueIn: 9 }, { name: "Agreement signed", dueIn: 45 }],
    lastActivityDays: 10,
  },
  {
    key: "bbopbrand", workspace: "digital", name: "BBOP Brand Refresh", company: "bbop",
    status: "completed", type: "consulting", priority: "medium",
    description: "Logo, colour system and brand guidelines. Completed ahead of the website work.",
    startAgo: 150, targetIn: -70, budget: 18000, revenue: 18000,
    contacts: ["james", "bbopcomms"],
    milestones: [
      { name: "Brand workshop", dueIn: -130, done: true },
      { name: "Identity delivered", dueIn: -70, done: true },
    ],
    lastActivityDays: 70,
  },
];

async function seedProjects() {
  for (const p of PROJECTS) {
    const completed = p.status === "completed";
    const created = await db.project.create({
      data: {
        workspaceId: ws[p.workspace]!,
        name: p.name,
        companyId: p.company ? companyId[p.company] : null,
        statusId: statusId[p.workspace]![p.status]!,
        type: p.type,
        priority: p.priority,
        description: p.description,
        ownerId: userId,
        startDate: daysAgo(p.startAgo),
        targetDate: daysAhead(p.targetIn),
        completedAt: completed ? daysAgo(Math.abs(p.targetIn)) : null,
        budgetCents: p.budget ? dollars(p.budget) : null,
        revenueCents: p.revenue ? dollars(p.revenue) : null,
        nextAction: p.nextAction,
        nextActionDueAt: p.nextActionIn !== undefined ? daysAhead(p.nextActionIn) : null,
        lastActivityAt: daysAgo(p.lastActivityDays),
        createdAt: daysAgo(p.startAgo + 4),
        contacts: {
          create: p.contacts.map((key, i) => ({
            contactId: contactId[key]!,
            role: i === 0 ? "Primary" : undefined,
          })),
        },
        milestones: {
          create: p.milestones.map((m, i) => ({
            name: m.name,
            order: i,
            dueDate: daysAhead(m.dueIn),
            completedAt: m.done ? daysAhead(m.dueIn - 1) : null,
          })),
        },
      },
    });
    projectId[p.key] = created.id;
    await linkTags(p.workspace, "project", created.id, p.company ? ["Client"] : []);
  }
}

// ---------------------------------------------------------------------------
// Deals & opportunities
// ---------------------------------------------------------------------------

type SeedDeal = {
  key: string;
  workspace: string;
  name: string;
  company?: string;
  contact?: string;
  project?: string;
  stage: string;
  value: number;
  closeIn: number;
  source: string;
  nextStep?: string;
  stageDays: number;
  lastActivityDays: number | null;
  contacts?: string[];
  pipeline?: "sales" | "investors";
  lostReason?: string;
};

const DEALS: SeedDeal[] = [
  { key: "fullerplp2", workspace: "ai", name: "Fuller — Predictive Platform Phase 2", company: "fuller",
    contact: "provost", project: "fulleroutreach", stage: "Negotiation", value: 145000, closeIn: 18,
    source: "referral", nextStep: "Provost budget decision, then redline the SOW", stageDays: 22,
    lastActivityDays: 16, contacts: ["provost", "sarah"] },
  { key: "sjsuanalytics", workspace: "ai", name: "SJSU — Student Success Analytics", company: "sjsu",
    contact: "marcus", project: "sjsu", stage: "Proposal", value: 240000, closeIn: 34,
    source: "rfp_portal", nextStep: "Submit questions by the deadline, then the full proposal",
    stageDays: 9, lastActivityDays: 3, contacts: ["marcus", "sjsuproc"] },
  { key: "jessupexpand", workspace: "ai", name: "Jessup — Advising Dashboard Expansion", company: "jessup",
    contact: "tom", project: "jessupadvising", stage: "Verbal Yes", value: 52000, closeIn: 7,
    source: "network", nextStep: "Countersign and schedule the workshop", stageDays: 5,
    lastActivityDays: 4, contacts: ["tom"] },
  { key: "apupilot", workspace: "ai", name: "APU — Retention Pilot", company: "apu", contact: "apucio",
    stage: "Discovery", value: 68000, closeIn: 62, source: "event",
    stageDays: 47, lastActivityDays: 41, contacts: ["apucio"] },
  { key: "biolaconsort", workspace: "ai", name: "Biola — Consortium Exploration", company: "biola",
    contact: "biolaprov", stage: "Qualified", value: 40000, closeIn: 90, source: "referral",
    nextStep: "Introduce the consortium model on a joint call", stageDays: 18, lastActivityDays: 24,
    contacts: ["biolaprov"] },
  { key: "csulbwatch", workspace: "ai", name: "CSULB — Analytics Modernization", company: "csulb",
    contact: "csulbproc", stage: "New Lead", value: 300000, closeIn: 120, source: "rfp_portal",
    stageDays: 68, lastActivityDays: 68, contacts: ["csulbproc"] },
  { key: "fullerretain", workspace: "ai", name: "Fuller — Retention Model (Year 1)", company: "fuller",
    contact: "sarah", project: "plp", stage: "Won", value: 185000, closeIn: -74, source: "referral",
    stageDays: 74, lastActivityDays: 2, contacts: ["sarah", "provost"] },
  { key: "jessupaudit", workspace: "ai", name: "Jessup — Enrollment Audit", company: "jessup",
    contact: "tom", stage: "Won", value: 38000, closeIn: -40, source: "network",
    stageDays: 40, lastActivityDays: 4, contacts: ["tom"] },
  { key: "lostuniv", workspace: "ai", name: "Point Loma — Advising Analytics", stage: "Lost", value: 55000,
    closeIn: -22, source: "outbound", stageDays: 22, lastActivityDays: 22,
    lostReason: "Chose an incumbent vendor already embedded in their SIS." },

  { key: "bbopsite", workspace: "digital", name: "BBOP — Website Redesign", company: "bbop", contact: "james",
    project: "bbop", stage: "Won", value: 68000, closeIn: -60, source: "referral",
    stageDays: 60, lastActivityDays: 1, contacts: ["james", "bbopcomms"] },
  { key: "bboprfp", workspace: "digital", name: "BBOP — Donor Portal Phase 2", company: "bbop",
    contact: "james", project: "bbop", stage: "Discovery", value: 32000, closeIn: 45,
    source: "referral", nextStep: "Scope the recurring-giving requirements with Renee",
    stageDays: 8, lastActivityDays: 1, contacts: ["james", "bbopcomms", "bbopboard"] },
  { key: "seasidedeal", workspace: "digital", name: "Seaside Collective — Site Refresh", company: "seaside",
    contact: "seaside1", project: "seasidesite", stage: "Proposal", value: 34000, closeIn: 16,
    source: "referral", nextStep: "Send proposal with two scope options", stageDays: 4,
    lastActivityDays: 5, contacts: ["seaside1"] },
  { key: "meridiandeal", workspace: "digital", name: "Meridian Housing — Site Rebuild", company: "meridian",
    contact: "meridian1", project: "meridiansite", stage: "Qualified", value: 41000, closeIn: 70,
    source: "outbound", stageDays: 22, lastActivityDays: 22, contacts: ["meridian1"] },
  { key: "harborq3", workspace: "digital", name: "Harbor Health — Q3 Campaign Sprint", company: "harbor",
    contact: "harbormk", project: "harborretainer", stage: "Won", value: 12500, closeIn: -6,
    source: "inbound", stageDays: 6, lastActivityDays: 6, contacts: ["harbormk"] },
  { key: "bbopcontent", workspace: "digital", name: "BBOP — Content Migration Add-on", company: "bbop",
    contact: "james", project: "bbop", stage: "Won", value: 9500, closeIn: -2,
    source: "referral", stageDays: 2, lastActivityDays: 1, contacts: ["james"] },
  { key: "harborrenew", workspace: "digital", name: "Harbor Health — Retainer Renewal", company: "harbor",
    contact: "harbormk", project: "harborretainer", stage: "Negotiation", value: 54000, closeIn: 21,
    source: "inbound", nextStep: "Agree the Q4 scope and the new monthly rate", stageDays: 11,
    lastActivityDays: 8, contacts: ["harbormk", "harborops"] },

  { key: "fieldnotesexp", workspace: "dropq", name: "Fieldnotes — Expand to 12 stores", company: "fieldnotes",
    contact: "fieldnotes1", project: "dropqlaunch", stage: "Verbal Yes", value: 28800, closeIn: 12,
    source: "inbound", nextStep: "Confirm rollout schedule for the remaining 8 stores",
    stageDays: 6, lastActivityDays: 3, contacts: ["fieldnotes1", "fieldnotes2"] },
  { key: "verdedeal", workspace: "dropq", name: "Verde Grocers — 3-Store Pilot", company: "verdegrocers",
    contact: "verde1", project: "verdepilot", stage: "Negotiation", value: 30000, closeIn: 25,
    source: "outbound", nextStep: "Security questionnaire returned, then schedule installs",
    stageDays: 31, lastActivityDays: 26, contacts: ["verde1", "verde2"] },
  { key: "northgatedeal", workspace: "dropq", name: "Northgate Markets — Evaluation", company: "northgate",
    contact: "northgate1", stage: "New Lead", value: 120000, closeIn: 150, source: "event",
    stageDays: 52, lastActivityDays: 52, contacts: ["northgate1"] },
  { key: "fieldnotesfirst", workspace: "dropq", name: "Fieldnotes — Pilot (4 stores)", company: "fieldnotes",
    contact: "fieldnotes1", project: "dropqlaunch", stage: "Won", value: 9600, closeIn: -55,
    source: "inbound", stageDays: 55, lastActivityDays: 3, contacts: ["fieldnotes1"] },

  { key: "cascadeseed", workspace: "bizdev", name: "Cascade Seed Partners — Lead", company: "cascade",
    contact: "cascade1", project: "seedround", stage: "Diligence", value: 1000000, closeIn: 35,
    source: "network", nextStep: "Send the metrics memo before the partner meeting",
    stageDays: 14, lastActivityDays: 7, contacts: ["cascade1", "cascade2"], pipeline: "investors" },
  { key: "tidewaterseed", workspace: "bizdev", name: "Tidewater Ventures — Follow", company: "tidewater",
    contact: "tidewater1", project: "seedround", stage: "First Meeting", value: 250000, closeIn: 60,
    source: "referral", stageDays: 38, lastActivityDays: 38, contacts: ["tidewater1"], pipeline: "investors" },
];

async function seedDeals(investorPipelineId: string, investorStageIds: Record<string, string>) {
  for (const d of DEALS) {
    const useInvestor = d.pipeline === "investors";
    const pipeline = useInvestor ? investorPipelineId : dealPipelineId[d.workspace]!;
    const stage = useInvestor ? investorStageIds[d.stage]! : dealStageId[d.workspace]![d.stage]!;
    const isClosed = ["Won", "Lost", "Committed", "Passed"].includes(d.stage);

    const created = await db.deal.create({
      data: {
        workspaceId: ws[d.workspace]!,
        name: d.name,
        companyId: d.company ? companyId[d.company] : null,
        primaryContactId: d.contact ? contactId[d.contact] : null,
        projectId: d.project ? projectId[d.project] : null,
        pipelineId: pipeline,
        stageId: stage,
        valueCents: dollars(d.value),
        expectedCloseAt: daysAhead(d.closeIn),
        ownerId: userId,
        source: d.source,
        nextStep: d.nextStep,
        stageEnteredAt: daysAgo(d.stageDays),
        lastActivityAt: d.lastActivityDays === null ? null : daysAgo(d.lastActivityDays),
        closedAt: isClosed ? daysAhead(d.closeIn) : null,
        lostReason: d.lostReason,
        createdAt: daysAgo(d.stageDays + randInt(15, 60)),
        contacts: {
          create: (d.contacts ?? []).map((key, i) => ({
            contactId: contactId[key]!,
            role: i === 0 ? "Primary" : undefined,
          })),
        },
      },
    });
    dealId[d.key] = created.id;
  }
}

type SeedOpportunity = {
  key: string;
  workspace: string;
  name: string;
  company?: string;
  project?: string;
  stage: string;
  type: string;
  source: string;
  solicitation?: string;
  postedAgo: number;
  questionsIn?: number;
  proposalIn: number;
  value: number;
  fitScore: number;
  strategicValue: string;
  competition: string;
  submissionStatus: string;
  requirements: string;
  contacts: string[];
};

const OPPORTUNITIES: SeedOpportunity[] = [
  {
    key: "sjsurfp", workspace: "ai", name: "SJSU — Student Success Analytics Platform (RFP)",
    company: "sjsu", project: "sjsu", stage: "Drafting", type: "rfp", source: "Cal eProcure",
    solicitation: "SJSU-2026-0417", postedAgo: 19, questionsIn: 2, proposalIn: 9,
    value: 240000, fitScore: 88, strategicValue: "high", competition: "high",
    submissionStatus: "drafting",
    requirements:
      "• Predictive retention modeling across SIS and LMS data\n• FERPA-compliant hosting in a US region\n• Advisor-facing dashboard with caseload routing\n• Integration with PeopleSoft Campus Solutions\n• Annual model validation and bias audit\n• Three higher-education references within the CSU or UC systems\n• Small business preference documentation\n• Section 508 / WCAG 2.1 AA accessibility conformance",
    contacts: ["marcus", "sjsuproc"],
  },
  {
    key: "csulbrfp", workspace: "ai", name: "CSULB — Analytics Modernization (Anticipated)",
    company: "csulb", stage: "Identified", type: "rfp", source: "Cal eProcure",
    solicitation: "TBD", postedAgo: 0, proposalIn: 74, value: 300000, fitScore: 71,
    strategicValue: "high", competition: "high", submissionStatus: "not_started",
    requirements:
      "Not yet published. Based on the prior cycle, expect: data warehouse modernization, student success dashboards, and a five-year support term.",
    contacts: ["csulbproc"],
  },
  {
    key: "irvinegrant", workspace: "ai", name: "Irvine Foundation — Educational Equity Grant",
    stage: "Reviewing", type: "grant", source: "Foundation portal", postedAgo: 12,
    questionsIn: 6, proposalIn: 27, value: 150000, fitScore: 62, strategicValue: "medium",
    competition: "medium", submissionStatus: "not_started",
    requirements:
      "• Demonstrated equity outcomes in California higher education\n• 501(c)(3) fiscal sponsor or partner institution\n• Three-year outcome measurement plan\n• Budget narrative with matching contribution",
    contacts: ["advisor1"],
  },
  {
    key: "sdcountyrfp", workspace: "digital", name: "San Diego County — Youth Services Web Portal",
    stage: "Go Decision", type: "rfp", source: "County procurement portal",
    solicitation: "SDC-HHSA-2026-118", postedAgo: 8, questionsIn: 4, proposalIn: 21,
    value: 185000, fitScore: 74, strategicValue: "high", competition: "medium",
    submissionStatus: "not_started",
    requirements:
      "• Accessible multilingual portal (English and Spanish)\n• CMS with county IT security review\n• Prior public-sector work of similar scope\n• Insurance certificates and county vendor registration\n• Prevailing wage compliance for any onsite work",
    contacts: ["james"],
  },
  {
    key: "meridiangrant", workspace: "digital", name: "Meridian — HUD Technical Assistance Set-Aside",
    company: "meridian", project: "meridiansite", stage: "Reviewing", type: "grant",
    source: "Partner referral", postedAgo: 15, proposalIn: 40, value: 65000, fitScore: 55,
    strategicValue: "medium", competition: "low", submissionStatus: "not_started",
    requirements:
      "• Subrecipient of a HUD-funded organization\n• Digital accessibility remediation plan\n• Cost allocation across the grant period",
    contacts: ["meridian1"],
  },
  {
    key: "ngapartner", workspace: "dropq", name: "NGA Retail Innovation Program",
    stage: "Submitted", type: "partnership", source: "Trade association", postedAgo: 34,
    proposalIn: -6, value: 0, fitScore: 80, strategicValue: "high", competition: "medium",
    submissionStatus: "submitted",
    requirements:
      "• Live deployment in at least one independent grocer\n• Measured labour or throughput improvement\n• Willingness to co-present at the annual show",
    contacts: ["northgate1"],
  },
];

async function seedOpportunities() {
  for (const o of OPPORTUNITIES) {
    const created = await db.opportunity.create({
      data: {
        workspaceId: ws[o.workspace]!,
        name: o.name,
        companyId: o.company ? companyId[o.company] : null,
        projectId: o.project ? projectId[o.project] : null,
        pipelineId: oppPipelineId[o.workspace]!,
        stageId: oppStageId[o.workspace]![o.stage]!,
        type: o.type,
        source: o.source,
        solicitationNumber: o.solicitation,
        postedAt: o.postedAgo ? daysAgo(o.postedAgo) : null,
        questionsDeadlineAt: o.questionsIn !== undefined ? daysAhead(o.questionsIn) : null,
        proposalDeadlineAt: daysAhead(o.proposalIn),
        deadlineAt: daysAhead(o.proposalIn),
        estimatedValueCents: dollars(o.value),
        fitScore: o.fitScore,
        strategicValue: o.strategicValue,
        competitionLevel: o.competition,
        requirements: o.requirements,
        submissionStatus: o.submissionStatus,
        ownerId: userId,
        createdAt: daysAgo(o.postedAgo || 30),
        contacts: { create: o.contacts.map((key) => ({ contactId: contactId[key]! })) },
      },
    });
    oppId[o.key] = created.id;
    await linkTags(o.workspace, "opportunity", created.id, o.type === "rfp" ? ["RFP", "Government"] : ["Strategic"]);
  }
}

// ---------------------------------------------------------------------------
// Tasks, notes, activity, communications
// ---------------------------------------------------------------------------

type SeedTask = {
  title: string;
  workspace: string;
  dueIn?: number;
  priority?: string;
  status?: string;
  description?: string;
  project?: string;
  deal?: string;
  contact?: string;
  company?: string;
  opportunity?: string;
  recurrence?: string;
};

const TASKS: SeedTask[] = [
  // Today / overdue — the dashboard's reason to exist.
  { title: "Follow up with Provost Okonkwo on the Phase 2 budget", workspace: "ai", dueIn: -3,
    priority: "urgent", contact: "provost", deal: "fullerplp2", project: "fulleroutreach",
    description: "He said a decision by the end of last week. Third follow-up — call rather than email this time." },
  { title: "Submit SJSU clarification questions", workspace: "ai", dueIn: 0, priority: "urgent",
    opportunity: "sjsurfp", project: "sjsu",
    description: "Questions deadline closes today at 5pm PT. Confirm the PeopleSoft integration scope and the reference requirement." },
  { title: "Send revised donor portal wireframes to James", workspace: "digital", dueIn: 0,
    priority: "high", contact: "james", project: "bbop", deal: "bboprfp" },
  { title: "Chase Roy Tanaka on the Verde security questionnaire", workspace: "dropq", dueIn: -2,
    priority: "high", contact: "verde2", deal: "verdedeal", project: "verdepilot",
    description: "26 days of silence. If nothing by Friday, escalate to Carla." },
  { title: "Send Cascade the updated metrics memo", workspace: "bizdev", dueIn: 1, priority: "urgent",
    contact: "cascade1", deal: "cascadeseed", project: "seedround",
    description: "Partner meeting is next week. Include the Fieldnotes retention curve." },
  { title: "Reply to Mia at Seaside with the proposal", workspace: "digital", dueIn: 1, priority: "high",
    contact: "seaside1", deal: "seasidedeal", project: "seasidesite" },
  { title: "Confirm FERPA addendum with Priya", workspace: "ai", dueIn: 2, priority: "high",
    contact: "fullerit", project: "plp" },
  { title: "Write the SJSU technical narrative", workspace: "ai", dueIn: 4, priority: "urgent",
    opportunity: "sjsurfp", project: "sjsu", status: "in_progress",
    description: "Sections 3.1–3.4. Reuse the Fuller validation methodology, updated for CSU scale." },
  { title: "Ship self-serve onboarding to staging", workspace: "dropq", dueIn: 5, priority: "high",
    project: "dropqlaunch", status: "in_progress" },
  { title: "Countersign the Jessup expansion SOW", workspace: "ai", dueIn: 3, priority: "high",
    contact: "tom", deal: "jessupexpand" },
  { title: "Go / no-go on the San Diego County youth portal", workspace: "digital", dueIn: 3,
    priority: "high", opportunity: "sdcountyrfp",
    description: "Need county vendor registration before we can bid. Check whether that takes longer than 21 days." },
  { title: "Prepare Q4 open-enrollment scope for Harbor", workspace: "digital", dueIn: 9,
    priority: "medium", contact: "harbormk", project: "harborretainer", deal: "harborrenew" },
  { title: "Run the Jessup advisor workshop", workspace: "ai", dueIn: 8, priority: "medium",
    project: "jessupadvising", contact: "tom" },
  { title: "Draft Lattice referral economics", workspace: "bizdev", dueIn: 9, priority: "medium",
    contact: "lattice1", project: "latticepartner" },
  { title: "Re-engage Grace Lim at APU", workspace: "ai", dueIn: -9, priority: "medium",
    contact: "apucio", deal: "apupilot",
    description: "41 days quiet. Their budget cycle opens in July — worth a short, specific note." },
  { title: "Follow up with Paul at Tidewater", workspace: "bizdev", dueIn: -12, priority: "medium",
    contact: "tidewater1", deal: "tidewaterseed" },
  { title: "Review model drift on the Fuller retention scores", workspace: "ai", dueIn: 6,
    priority: "medium", project: "plp", recurrence: "monthly" },
  { title: "Weekly pipeline review", workspace: "ai", dueIn: 2, priority: "low", recurrence: "weekly" },
  { title: "Stakeholder interviews at Meridian", workspace: "digital", dueIn: 10, priority: "low",
    project: "meridiansite", contact: "meridian1" },
  { title: "Schedule Northgate follow-up call", workspace: "dropq", dueIn: 14, priority: "low",
    contact: "northgate1", deal: "northgatedeal" },
  { title: "Send quarterly update to Fieldnotes", workspace: "dropq", dueIn: 12, priority: "medium",
    contact: "fieldnotes1", recurrence: "quarterly" },
  { title: "Book Q4 tax planning call with Michelle", workspace: "bizdev", dueIn: 20, priority: "low",
    contact: "cpa" },
  { title: "Draft the Irvine Foundation LOI", workspace: "ai", dueIn: 18, priority: "medium",
    opportunity: "irvinegrant" },
  { title: "Content migration plan for BBOP", workspace: "digital", dueIn: 12, priority: "medium",
    project: "bbop" },

  // Completed — so "Tasks completed" analytics have something real behind them.
  { title: "Deliver Fuller advisor dashboard v1", workspace: "ai", dueIn: -8, status: "done", project: "plp" },
  { title: "BBOP design system sign-off", workspace: "digital", dueIn: -6, status: "done", project: "bbop" },
  { title: "Billing and subscriptions for DropQ", workspace: "dropq", dueIn: -5, status: "done", project: "dropqlaunch" },
  { title: "Send Jessup enrollment audit findings", workspace: "ai", dueIn: -25, status: "done", project: "jessupadvising" },
  { title: "Q3 campaign pages for Harbor", workspace: "digital", dueIn: -8, status: "done", project: "harborretainer" },
  { title: "Build the DropQ data room", workspace: "bizdev", dueIn: -30, status: "done", project: "seedround" },
  { title: "SJSU go / no-go decision", workspace: "ai", dueIn: -14, status: "done", opportunity: "sjsurfp" },
  { title: "Fieldnotes pilot install — 4 stores", workspace: "dropq", dueIn: -30, status: "done", project: "dropqlaunch" },
  { title: "Send Cascade the deck", workspace: "bizdev", dueIn: -20, status: "done", contact: "cascade1", deal: "cascadeseed" },
  { title: "BBOP information architecture workshop", workspace: "digital", dueIn: -26, status: "done", project: "bbop" },
];

async function seedTasks() {
  for (const [i, t] of TASKS.entries()) {
    const status = t.status ?? "open";
    await db.task.create({
      data: {
        workspaceId: ws[t.workspace]!,
        title: t.title,
        description: t.description,
        ownerId: userId,
        dueAt: t.dueIn !== undefined ? daysAhead(t.dueIn, 17) : null,
        priority: t.priority ?? "medium",
        status,
        completedAt: status === "done" ? daysAhead((t.dueIn ?? 0) + 1) : null,
        recurrence: t.recurrence ?? "none",
        sortOrder: i,
        projectId: t.project ? projectId[t.project] : null,
        dealId: t.deal ? dealId[t.deal] : null,
        contactId: t.contact ? contactId[t.contact] : null,
        companyId: t.company ? companyId[t.company] : null,
        opportunityId: t.opportunity ? oppId[t.opportunity] : null,
        createdAt: daysAgo(randInt(1, 30)),
      },
    });
  }
}

type SeedNote = {
  workspace: string;
  title: string;
  body: string;
  daysAgo: number;
  pinned?: boolean;
  project?: string;
  deal?: string;
  contact?: string;
  company?: string;
  opportunity?: string;
};

const NOTES: SeedNote[] = [
  {
    workspace: "ai", title: "Call with Sarah — provost is in", contact: "sarah", company: "fuller",
    deal: "fullerplp2", daysAgo: 2, pinned: true,
    body: `<p>Talked to <strong>Sarah at Fuller</strong>. She said the provost is interested and wants a demo next month.</p>
<ul><li>Phase 2 would cover the wider seminary consortium — she thinks 4–6 institutions.</li><li>Budget sits with Okonkwo, not with her. She will push but cannot decide.</li><li>They want the bias audit written into the contract this time.</li></ul>
<p>Tone was <em>positive</em>. The one risk is timing: their fiscal year turns over and unspent budget does not roll.</p>`,
  },
  {
    workspace: "ai", title: "SJSU proposal — what actually matters", opportunity: "sjsurfp",
    project: "sjsu", daysAgo: 4,
    body: `<h3>Read of the solicitation</h3><p>Evaluation is 40% technical, 30% experience, 30% price. Price is weighted higher than the last CSU bid, so the premium approach will not win on merit alone.</p>
<ul><li>Three CSU/UC references is the binding constraint. We have Fuller and Jessup — neither is CSU.</li><li>PeopleSoft integration is stated but the scope is vague. Ask in questions.</li><li>Section 508 conformance needs a VPAT. We do not have one for the advisor dashboard.</li></ul>
<p><strong>Recommendation:</strong> bid, but price at the middle of the range and lead with the validation methodology.</p>`,
  },
  {
    workspace: "digital", title: "BBOP board feedback on wireframes", contact: "bbopboard",
    company: "bbop", project: "bbop", daysAgo: 6,
    body: `<p>Walter passed on board comments from Tuesday.</p><ul><li>Donor portal needs recurring giving front and centre — it is 60% of their revenue.</li><li>They want program registration and donation in the same flow.</li><li>Someone asked about a Spanish version. Not in scope, but worth pricing as an option.</li></ul>`,
  },
  {
    workspace: "dropq", title: "Verde security review is the whole blocker", company: "verdegrocers",
    deal: "verdedeal", project: "verdepilot", daysAgo: 26,
    body: `<p>Carla is bought in. Roy's security review is what is holding this up, and he has not responded in almost four weeks.</p><p>Their questionnaire is the standard retail one — SOC 2, data residency, PCI scope. We do not have SOC 2. Need to decide whether to pursue it or offer a compensating-controls letter.</p>`,
  },
  {
    workspace: "bizdev", title: "Cascade partner meeting prep", contact: "cascade1", company: "cascade",
    deal: "cascadeseed", project: "seedround", daysAgo: 7, pinned: true,
    body: `<p>Ian wants three things before the partner meeting:</p><ol><li>Retention curve for Fieldnotes across the four pilot stores.</li><li>A credible path from $24k to $250k ARR.</li><li>Why curbside and not full delivery.</li></ol>
<p>He was direct that the fund's concern is market size. The Verde pilot closing would answer most of it.</p>`,
  },
  {
    workspace: "ai", title: "Jessup expansion — verbal yes", contact: "tom", company: "jessup",
    deal: "jessupexpand", daysAgo: 5,
    body: `<p>Tom confirmed on the call: they are going ahead with the advising dashboard. $52k, same terms as the audit. Paperwork through their procurement, which he says takes about a week.</p><p>He asked whether we could start the workshop before the SOW is countersigned. Said yes in principle.</p>`,
  },
  {
    workspace: "ai", title: "APU — went quiet after the summit", contact: "apucio", company: "apu",
    deal: "apupilot", daysAgo: 41,
    body: `<p>Grace was genuinely engaged at the data summit but nothing since. Two emails, no reply.</p><p>Her budget cycle opens in July. Probably not dead — just early. Worth a short note referencing something specific rather than another check-in.</p>`,
  },
  {
    workspace: "digital", title: "Harbor renewal — they want more for less", contact: "harbormk",
    company: "harbor", deal: "harborrenew", daysAgo: 8,
    body: `<p>Denise wants to add patient-comms email production to the retainer without raising the monthly. Andre controls the number.</p><p>Current retainer is $4,500/mo. The added scope is realistically another 8–10 hours. Either the rate goes up or something comes out.</p>`,
  },
  {
    workspace: "digital", title: "Seaside — scope options", contact: "seaside1", company: "seaside",
    deal: "seasidedeal", daysAgo: 5,
    body: `<p>Mia wants it live before summer. Two options to send:</p><ul><li><strong>A — $34k:</strong> full refresh across all four sites, unified booking.</li><li><strong>B — $19k:</strong> flagship site only, others get the template later.</li></ul><p>She is price-sensitive but the deadline is real, which usually matters more.</p>`,
  },
  {
    workspace: "dropq", title: "Fieldnotes pilot results", contact: "fieldnotes1", company: "fieldnotes",
    project: "dropqlaunch", daysAgo: 12,
    body: `<h3>Four stores, six weeks</h3><ul><li>Average pickup wait down from 6.2 to 2.4 minutes.</li><li>Order errors down about a third.</li><li>Staff adoption was the hard part — took two weeks and a printed one-pager.</li></ul><p>Hana wants the remaining 8 stores. This is the reference case for everything else.</p>`,
  },
];

async function seedNotes() {
  for (const n of NOTES) {
    await db.note.create({
      data: {
        workspaceId: ws[n.workspace]!,
        title: n.title,
        body: n.body,
        plainText: n.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        authorId: userId,
        pinned: n.pinned ?? false,
        projectId: n.project ? projectId[n.project] : null,
        dealId: n.deal ? dealId[n.deal] : null,
        contactId: n.contact ? contactId[n.contact] : null,
        companyId: n.company ? companyId[n.company] : null,
        opportunityId: n.opportunity ? oppId[n.opportunity] : null,
        createdAt: daysAgo(n.daysAgo),
        updatedAt: daysAgo(n.daysAgo),
      },
    });
  }
}

const ACTIVITIES: ActivityInput[] = [
  { workspace: "ai", type: "call", title: "Call with Sarah Whitfield", direction: "inbound", daysAgo: 2,
    durationMin: 32, contact: "sarah", company: "fuller", deal: "fullerplp2", project: "plp",
    body: "Provost is interested and wants a demo next month. Budget decision still sits with Okonkwo." },
  { workspace: "ai", type: "email", title: "Re: Phase 2 budget timing", direction: "outbound", daysAgo: 16,
    contact: "provost", company: "fuller", deal: "fullerplp2", project: "fulleroutreach",
    body: "Third follow-up on the Phase 2 budget decision. No reply yet." },
  { workspace: "ai", type: "meeting", title: "Advisor dashboard walkthrough", daysAgo: 9, durationMin: 60,
    contact: "fullerit", company: "fuller", project: "plp",
    body: "Walked Priya through the dashboard. FERPA addendum is the remaining blocker." },
  { workspace: "ai", type: "stage_change", title: "Moved to Proposal", daysAgo: 9, deal: "sjsuanalytics",
    company: "sjsu", meta: { from: "Discovery", to: "Proposal" } },
  { workspace: "ai", type: "meeting", title: "SJSU pre-bid conference", daysAgo: 6, durationMin: 45,
    contact: "marcus", company: "sjsu", deal: "sjsuanalytics", opportunity: "sjsurfp",
    body: "Attended the pre-bid call. 14 vendors on the line. Marcus stayed on afterwards for five minutes — good sign." },
  { workspace: "ai", type: "note", title: "SJSU proposal — what actually matters", daysAgo: 4,
    opportunity: "sjsurfp", project: "sjsu" },
  { workspace: "ai", type: "call", title: "Jessup expansion — verbal yes", direction: "inbound", daysAgo: 5,
    durationMin: 25, contact: "tom", company: "jessup", deal: "jessupexpand" },
  { workspace: "ai", type: "stage_change", title: "Moved to Verbal Yes", daysAgo: 5, deal: "jessupexpand",
    company: "jessup", meta: { from: "Negotiation", to: "Verbal Yes" } },
  { workspace: "ai", type: "email", title: "Checking in after the data summit", direction: "outbound",
    daysAgo: 41, contact: "apucio", company: "apu", deal: "apupilot" },
  { workspace: "ai", type: "email", title: "Intro from Fuller's provost", direction: "inbound", daysAgo: 24,
    contact: "biolaprov", company: "biola", deal: "biolaconsort" },
  { workspace: "ai", type: "file", title: "Uploaded SJSU-2026-0417 solicitation.pdf", daysAgo: 19,
    opportunity: "sjsurfp", company: "sjsu" },
  { workspace: "ai", type: "project_update", title: "Pilot cohorts confirmed", daysAgo: 2, project: "plp",
    body: "Three advising cohorts confirmed for the pilot. Starts after the FERPA addendum lands." },

  { workspace: "digital", type: "meeting", title: "Weekly BBOP check-in", daysAgo: 1, durationMin: 30,
    contact: "james", company: "bbop", project: "bbop", deal: "bboprfp",
    body: "Reviewed donor portal direction. James wants recurring giving to be the default, not an option." },
  { workspace: "digital", type: "email", title: "Board feedback on wireframes", direction: "inbound",
    daysAgo: 6, contact: "bbopboard", company: "bbop", project: "bbop" },
  { workspace: "digital", type: "note", title: "BBOP board feedback on wireframes", daysAgo: 6,
    company: "bbop", project: "bbop" },
  { workspace: "digital", type: "call", title: "Harbor renewal conversation", direction: "outbound",
    daysAgo: 8, durationMin: 22, contact: "harbormk", company: "harbor", deal: "harborrenew" },
  { workspace: "digital", type: "email", title: "Proposal options for the refresh", direction: "outbound",
    daysAgo: 5, contact: "seaside1", company: "seaside", deal: "seasidedeal" },
  { workspace: "digital", type: "email", title: "Following up on the rebuild", direction: "outbound",
    daysAgo: 22, contact: "meridian1", company: "meridian", deal: "meridiandeal" },
  { workspace: "digital", type: "stage_change", title: "Moved to Won", daysAgo: 60, deal: "bbopsite",
    company: "bbop", meta: { from: "Verbal Yes", to: "Won" } },
  { workspace: "digital", type: "stage_change", title: "Moved to Won", daysAgo: 6, deal: "harborq3",
    company: "harbor", contact: "harbormk", project: "harborretainer",
    meta: { from: "Verbal Yes", to: "Won" }, body: "Q3 campaign pages approved and invoiced." },
  { workspace: "digital", type: "stage_change", title: "Moved to Won", daysAgo: 2, deal: "bbopcontent",
    company: "bbop", contact: "james", project: "bbop", meta: { from: "Proposal", to: "Won" },
    body: "James approved the content migration add-on." },

  { workspace: "dropq", type: "meeting", title: "Fieldnotes rollout planning", daysAgo: 3, durationMin: 45,
    contact: "fieldnotes1", company: "fieldnotes", deal: "fieldnotesexp", project: "dropqlaunch",
    body: "Hana wants all 12 stores by end of quarter. Sequencing around their two busiest locations." },
  { workspace: "dropq", type: "email", title: "Security questionnaire — following up", direction: "outbound",
    daysAgo: 26, contact: "verde2", company: "verdegrocers", deal: "verdedeal", project: "verdepilot" },
  { workspace: "dropq", type: "email", title: "Re: DropQ pilot terms", direction: "inbound", daysAgo: 31,
    contact: "verde1", company: "verdegrocers", deal: "verdedeal" },
  { workspace: "dropq", type: "project_update", title: "Billing shipped", daysAgo: 5, project: "dropqlaunch",
    body: "Subscriptions and metered billing are live. Self-serve onboarding is next." },
  { workspace: "dropq", type: "email", title: "Nice to meet you at NGA", direction: "outbound", daysAgo: 52,
    contact: "northgate1", company: "northgate", deal: "northgatedeal" },

  { workspace: "bizdev", type: "meeting", title: "Cascade — first partner conversation", daysAgo: 7,
    durationMin: 50, contact: "cascade1", company: "cascade", deal: "cascadeseed", project: "seedround",
    body: "Ian wants the retention curve, a path to $250k ARR, and the case for curbside over delivery." },
  { workspace: "bizdev", type: "stage_change", title: "Moved to Diligence", daysAgo: 14, deal: "cascadeseed",
    company: "cascade", meta: { from: "First Meeting", to: "Diligence" } },
  { workspace: "bizdev", type: "email", title: "Sending the deck", direction: "outbound", daysAgo: 38,
    contact: "tidewater1", company: "tidewater", deal: "tidewaterseed" },
  { workspace: "bizdev", type: "call", title: "Lattice partnership exploration", direction: "outbound",
    daysAgo: 10, durationMin: 35, contact: "lattice1", company: "lattice", project: "latticepartner" },
];

async function seedActivities() {
  for (const a of [...ACTIVITIES, ...activityQueue]) {
    await db.activity.create({
      data: {
        workspaceId: ws[a.workspace]!,
        type: a.type,
        title: a.title,
        body: a.body,
        direction: a.direction,
        durationMin: a.durationMin,
        meta: a.meta ? JSON.stringify(a.meta) : null,
        occurredAt: daysAgo(a.daysAgo, a.hour ?? randInt(9, 17)),
        actorId: userId,
        contactId: a.contact ? contactId[a.contact] : null,
        companyId: a.company ? companyId[a.company] : null,
        dealId: a.deal ? dealId[a.deal] : null,
        projectId: a.project ? projectId[a.project] : null,
        opportunityId: a.opportunity ? oppId[a.opportunity] : null,
        createdAt: daysAgo(a.daysAgo),
      },
    });
  }

  // Company lastActivityAt is derived from the stream rather than hand-set, so
  // the demo data is internally consistent with what the app would compute.
  for (const key of Object.keys(companyId)) {
    const latest = await db.activity.findFirst({
      where: { companyId: companyId[key] },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    });
    if (latest) {
      await db.company.update({ where: { id: companyId[key]! }, data: { lastActivityAt: latest.occurredAt } });
    }
  }
}

// --- Email & calendar (mock provider) --------------------------------------

const EMAILS = [
  { workspace: "ai", contact: "sarah", subject: "Re: Phase 2 scope and the consortium",
    snippet: "Okonkwo asked me to pull together what the four other schools would need…", direction: "inbound",
    daysAgo: 2, thread: "t-fuller-1", needsReply: false },
  { workspace: "ai", contact: "provost", subject: "Phase 2 budget — checking in",
    snippet: "Following up on the Phase 2 budget decision we discussed. Happy to walk through…",
    direction: "outbound", daysAgo: 16, thread: "t-fuller-2", needsReply: true },
  { workspace: "ai", contact: "marcus", subject: "Re: Pre-bid conference questions",
    snippet: "Good question on the PeopleSoft scope — submit it formally and procurement will…",
    direction: "inbound", daysAgo: 6, thread: "t-sjsu-1", needsReply: true },
  { workspace: "ai", contact: "apucio", subject: "Following up after the data summit",
    snippet: "Great to meet you last month. I put together a short note on what a retention pilot…",
    direction: "outbound", daysAgo: 41, thread: "t-apu-1", needsReply: true },
  { workspace: "digital", contact: "james", subject: "Re: Donor portal wireframes",
    snippet: "The board had a few thoughts — recurring giving needs to be the front door…",
    direction: "inbound", daysAgo: 1, thread: "t-bbop-1", needsReply: true },
  { workspace: "digital", contact: "harbormk", subject: "Retainer scope for Q4",
    snippet: "Would it be possible to fold the patient comms emails into the existing retainer?",
    direction: "inbound", daysAgo: 8, thread: "t-harbor-1", needsReply: true },
  { workspace: "digital", contact: "seaside1", subject: "Re: Site refresh",
    snippet: "This looks great. Can you send pricing with and without the other three locations?",
    direction: "inbound", daysAgo: 5, thread: "t-seaside-1", needsReply: true },
  { workspace: "dropq", contact: "fieldnotes1", subject: "Rollout schedule for the rest of the stores",
    snippet: "We'd like to move on the remaining eight. Can we start with Alberta and Division?",
    direction: "inbound", daysAgo: 3, thread: "t-fn-1", needsReply: false },
  { workspace: "dropq", contact: "verde2", subject: "Security questionnaire — following up",
    snippet: "Checking in on the security review. Let me know if anything else would help…",
    direction: "outbound", daysAgo: 26, thread: "t-verde-1", needsReply: true },
  { workspace: "bizdev", contact: "cascade1", subject: "Re: Metrics for the partner meeting",
    snippet: "Send over the retention curve when you have it and I'll circulate ahead of Tuesday.",
    direction: "inbound", daysAgo: 7, thread: "t-cascade-1", needsReply: true },
  { workspace: "bizdev", contact: "tidewater1", subject: "DropQ — deck attached",
    snippet: "Great meeting you at the dinner. Deck attached, happy to walk through it any time.",
    direction: "outbound", daysAgo: 38, thread: "t-tide-1", needsReply: true },
];

async function seedCommunications() {
  for (const [i, e] of EMAILS.entries()) {
    const contact = await db.contact.findUnique({
      where: { id: contactId[e.contact]! },
      select: { email: true, fullName: true, companyId: true },
    });
    const relatedDeal = await db.deal.findFirst({
      where: { primaryContactId: contactId[e.contact]!, archivedAt: null },
      select: { id: true, projectId: true },
      orderBy: { createdAt: "desc" },
    });
    await db.emailMessage.create({
      data: {
        workspaceId: ws[e.workspace]!,
        provider: "mock",
        externalId: `mock-${i}`,
        threadId: e.thread,
        subject: e.subject,
        snippet: e.snippet,
        body: `${e.snippet}\n\n—\nSent from ${e.direction === "inbound" ? contact?.fullName : "Bris Whitaker"}`,
        fromEmail: e.direction === "inbound" ? (contact?.email ?? "unknown@example.com") : "owner@tinycrm.app",
        fromName: e.direction === "inbound" ? (contact?.fullName ?? null) : "Bris Whitaker",
        toJson: JSON.stringify(
          e.direction === "inbound"
            ? [{ email: "owner@tinycrm.app", name: "Bris Whitaker" }]
            : [{ email: contact?.email, name: contact?.fullName }],
        ),
        direction: e.direction,
        sentAt: daysAgo(e.daysAgo, randInt(8, 18)),
        isRead: e.daysAgo > 1,
        needsReply: e.needsReply,
        contactId: contactId[e.contact]!,
        companyId: contact?.companyId ?? null,
        dealId: relatedDeal?.id ?? null,
        projectId: relatedDeal?.projectId ?? null,
      },
    });
  }

  const EVENTS = [
    { workspace: "digital", title: "BBOP weekly check-in", inDays: 1, hour: 10, dur: 30,
      contact: "james", company: "bbop", project: "bbop", url: "https://meet.google.com/tiny-crm-demo" },
    { workspace: "ai", title: "Fuller — advisor dashboard demo", inDays: 2, hour: 13, dur: 60,
      contact: "sarah", company: "fuller", project: "plp", url: "https://zoom.us/j/tinycrmdemo" },
    { workspace: "ai", title: "SJSU proposal working session", inDays: 3, hour: 9, dur: 120, project: "sjsu" },
    { workspace: "bizdev", title: "Cascade partner meeting", inDays: 6, hour: 11, dur: 45,
      contact: "cascade1", company: "cascade", project: "seedround", url: "https://meet.google.com/cascade-partners" },
    { workspace: "dropq", title: "Fieldnotes rollout sync", inDays: 4, hour: 15, dur: 30,
      contact: "fieldnotes1", company: "fieldnotes", project: "dropqlaunch" },
    { workspace: "ai", title: "Jessup advisor workshop", inDays: 8, hour: 9, dur: 180,
      contact: "tom", company: "jessup", project: "jessupadvising" },
    { workspace: "digital", title: "Harbor Q4 scoping", inDays: 9, hour: 14, dur: 45,
      contact: "harbormk", company: "harbor", project: "harborretainer" },
    { workspace: "ai", title: "Fuller — Priya, FERPA addendum", inDays: -2, hour: 11, dur: 30,
      contact: "fullerit", company: "fuller", project: "plp" },
    { workspace: "dropq", title: "Verde Grocers — pilot terms", inDays: -26, hour: 10, dur: 45,
      contact: "verde1", company: "verdegrocers", project: "verdepilot" },
  ];

  for (const [i, ev] of EVENTS.entries()) {
    const start = daysAhead(ev.inDays, ev.hour);
    const end = new Date(start.getTime() + ev.dur * 60_000);
    const contact = ev.contact
      ? await db.contact.findUnique({ where: { id: contactId[ev.contact]! }, select: { email: true, fullName: true } })
      : null;

    await db.calendarEvent.create({
      data: {
        workspaceId: ws[ev.workspace]!,
        provider: "mock",
        externalId: `mock-event-${i}`,
        title: ev.title,
        meetingUrl: ev.url,
        startAt: start,
        endAt: end,
        organizerId: userId,
        contactId: ev.contact ? contactId[ev.contact] : null,
        companyId: ev.company ? companyId[ev.company] : null,
        projectId: ev.project ? projectId[ev.project] : null,
        attendees: {
          create: [
            { email: "owner@tinycrm.app", name: "Bris Whitaker", status: "accepted" },
            ...(contact?.email
              ? [{ email: contact.email, name: contact.fullName, contactId: contactId[ev.contact!]!, status: "accepted" }]
              : []),
          ],
        },
      },
    });
  }

  for (const key of Object.keys(ws)) {
    await db.integration.create({
      data: {
        workspaceId: ws[key]!,
        userId,
        provider: "gmail",
        status: "mock",
        accountEmail: "owner@tinycrm.app",
        connectedAt: daysAgo(30),
        lastSyncAt: hoursAgoDate(2),
      },
    });
    await db.integration.create({
      data: {
        workspaceId: ws[key]!,
        userId,
        provider: "google_calendar",
        status: "mock",
        accountEmail: "owner@tinycrm.app",
        connectedAt: daysAgo(30),
        lastSyncAt: hoursAgoDate(2),
      },
    });
  }
}

function hoursAgoDate(hours: number) {
  return new Date(NOW.getTime() - hours * 3600_000);
}

// --- Automations, saved views, custom fields, notifications -----------------

async function seedWorkspaceExtras() {
  const automations = [
    {
      workspace: "ai", name: "Proposal follow-up", trigger: "deal_stage_changed",
      description: "When a deal reaches Proposal, create a follow-up task three days out.",
      conditions: [{ field: "stage.name", op: "equals", value: "Proposal" }],
      actions: [{ type: "create_task", title: "Follow up on the proposal", dueInDays: 3, priority: "high" }],
      runCount: 6,
    },
    {
      workspace: "ai", name: "RFP deadline warning", trigger: "opportunity_deadline_near",
      description: "Notify the owner seven days before an opportunity deadline.",
      conditions: [{ field: "daysUntilDeadline", op: "lte", value: 7 }],
      actions: [{ type: "notify_owner", message: "An opportunity deadline is a week away." }],
      runCount: 3,
    },
    {
      workspace: "digital", name: "Project kickoff checklist", trigger: "project_status_changed",
      description: "When a project becomes Active, create the standard kickoff checklist.",
      conditions: [{ field: "status.key", op: "equals", value: "active" }],
      actions: [
        {
          type: "create_checklist",
          items: ["Schedule kickoff call", "Share the project brief", "Confirm billing contact", "Set up the shared folder"],
          dueInDays: 5,
        },
      ],
      runCount: 4,
    },
    {
      workspace: "dropq", name: "Stale deal flag", trigger: "deal_inactive",
      description: "Flag a deal as stale after 14 days without activity.",
      conditions: [{ field: "daysSinceActivity", op: "gte", value: 14 }],
      actions: [{ type: "add_tag", tag: "Warm Lead" }, { type: "notify_owner", message: "This deal has gone quiet." }],
      runCount: 2,
    },
    {
      workspace: "bizdev", name: "New contact follow-up", trigger: "contact_created",
      description: "Every new contact gets a follow-up task two days later.",
      conditions: [],
      actions: [{ type: "create_task", title: "Initial follow-up", dueInDays: 2, priority: "medium" }],
      runCount: 9,
    },
  ];

  for (const a of automations) {
    const created = await db.automation.create({
      data: {
        workspaceId: ws[a.workspace]!,
        name: a.name,
        description: a.description,
        trigger: a.trigger,
        conditions: JSON.stringify(a.conditions),
        actions: JSON.stringify(a.actions),
        enabled: true,
        runCount: a.runCount,
        lastRunAt: daysAgo(randInt(1, 12)),
        createdAt: daysAgo(randInt(30, 120)),
      },
    });
    for (let i = 0; i < Math.min(3, a.runCount); i++) {
      await db.automationRun.create({
        data: {
          automationId: created.id,
          entityType: a.trigger.startsWith("deal") ? "deal" : a.trigger.startsWith("project") ? "project" : "contact",
          entityId: "seed",
          status: "success",
          message: `${a.actions[0]!.type} completed`,
          createdAt: daysAgo(randInt(1, 25)),
        },
      });
    }
  }

  const views = [
    { name: "Hot Leads", entityType: "deal", icon: "flame", workspace: null,
      filters: { match: "all", rules: [{ field: "stage.kind", op: "equals", value: "open" }, { field: "valueCents", op: "gte", value: 5000000 }] } },
    { name: "Government RFPs", entityType: "opportunity", icon: "landmark", workspace: "ai",
      filters: { match: "all", rules: [{ field: "type", op: "equals", value: "rfp" }] } },
    { name: "Needs Follow-Up", entityType: "contact", icon: "clock", workspace: null,
      filters: { match: "all", rules: [{ field: "nextFollowUpAt", op: "before", value: "today" }] } },
    { name: "Deals Closing This Month", entityType: "deal", icon: "calendar", workspace: null,
      filters: { match: "all", rules: [{ field: "expectedCloseAt", op: "within", value: "30d" }, { field: "stage.kind", op: "equals", value: "open" }] } },
    { name: "Projects At Risk", entityType: "project", icon: "alert-triangle", workspace: null,
      filters: { match: "any", rules: [{ field: "health", op: "in", value: ["at_risk", "off_track"] }] } },
    { name: "Investors", entityType: "contact", icon: "banknote", workspace: "bizdev",
      filters: { match: "all", rules: [{ field: "relationshipType", op: "equals", value: "investor" }] } },
  ];

  for (const [i, v] of views.entries()) {
    await db.savedView.create({
      data: {
        userId,
        workspaceId: v.workspace ? ws[v.workspace]! : null,
        name: v.name,
        icon: v.icon,
        entityType: v.entityType,
        filters: JSON.stringify(v.filters),
        order: i,
      },
    });
  }

  const fields = [
    { workspace: "ai", entityType: "company", key: "carnegie_class", label: "Carnegie Classification", type: "dropdown",
      options: ["Doctoral", "Master's", "Baccalaureate", "Special Focus"] },
    { workspace: "ai", entityType: "contact", key: "committee_role", label: "Committee Role", type: "text" },
    { workspace: "ai", entityType: "opportunity", key: "incumbent", label: "Incumbent Vendor", type: "text" },
    { workspace: "digital", entityType: "project", key: "cms", label: "CMS", type: "dropdown",
      options: ["WordPress", "Webflow", "Sanity", "Payload", "Custom"] },
    { workspace: "dropq", entityType: "company", key: "store_count", label: "Store Count", type: "number" },
    { workspace: "bizdev", entityType: "deal", key: "check_size", label: "Target Check Size", type: "currency" },
  ];

  for (const [i, f] of fields.entries()) {
    await db.customFieldDef.create({
      data: {
        workspaceId: ws[f.workspace]!,
        entityType: f.entityType,
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options ? JSON.stringify(f.options) : null,
        order: i,
      },
    });
  }

  // A few values so custom fields are visibly in use, not just configured.
  const carnegie = await db.customFieldDef.findFirst({ where: { key: "carnegie_class" } });
  if (carnegie) {
    for (const [key, value] of [["fuller", "Doctoral"], ["sjsu", "Master's"], ["jessup", "Baccalaureate"]] as const) {
      await db.customFieldValue.create({
        data: {
          workspaceId: ws.ai!, fieldId: carnegie.id, entityType: "company",
          entityId: companyId[key]!, value,
        },
      });
    }
  }
  const storeCount = await db.customFieldDef.findFirst({ where: { key: "store_count" } });
  if (storeCount) {
    for (const [key, value] of [["verdegrocers", 34], ["fieldnotes", 12], ["northgate", 41]] as const) {
      await db.customFieldValue.create({
        data: {
          workspaceId: ws.dropq!, fieldId: storeCount.id, entityType: "company",
          entityId: companyId[key]!, value: String(value), numberValue: value,
        },
      });
    }
  }

  const notifications = [
    { type: "task_overdue", title: "Follow up with Provost Okonkwo is 3 days overdue",
      body: "This is the third follow-up on the Phase 2 budget decision.", workspace: "ai", hours: 3 },
    { type: "opportunity_deadline", title: "SJSU questions deadline is today",
      body: "Clarification questions close at 5pm PT.", workspace: "ai", hours: 5 },
    { type: "deal_inactive", title: "Verde Grocers pilot has been quiet for 26 days",
      body: "No activity since the security questionnaire was sent.", workspace: "dropq", hours: 14 },
    { type: "project_risk", title: "Verde Grocers Pilot moved to at risk",
      body: "The security review is past its date and nothing has moved.", workspace: "dropq", hours: 20 },
    { type: "contact_followup", title: "4 contacts have gone quiet",
      body: "Grace Lim, Paul Marchetti, Vivian Cortez and Elena Vasquez.", workspace: null, hours: 26 },
    { type: "ai_recommendation", title: "Tiny AI found 2 possible duplicate records",
      body: "Review the suggestions in Settings → Data.", workspace: null, hours: 30 },
    { type: "deadline", title: "BBOP donor portal build is due in 9 days", workspace: "digital", hours: 40 },
  ];

  for (const [i, n] of notifications.entries()) {
    await db.notification.create({
      data: {
        userId,
        workspaceId: n.workspace ? ws[n.workspace]! : null,
        type: n.type,
        title: n.title,
        body: n.body,
        readAt: i > 3 ? daysAgo(1) : null,
        createdAt: hoursAgoDate(n.hours),
      },
    });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("Resetting…");
  await reset();

  console.log("Users and workspaces…");
  const { investorPipeline, investorStageIds } = await seedUserAndWorkspaces();

  console.log("Companies and contacts…");
  await seedAccounts();

  console.log("Projects…");
  await seedProjects();

  console.log("Deals and opportunities…");
  await seedDeals(investorPipeline.id, investorStageIds);
  await seedOpportunities();

  console.log("Tasks and notes…");
  await seedTasks();
  await seedNotes();

  console.log("Activity, email and calendar…");
  await seedActivities();
  await seedCommunications();

  console.log("Automations, views, fields, notifications…");
  await seedWorkspaceExtras();

  const counts = {
    workspaces: await db.workspace.count(),
    companies: await db.company.count(),
    contacts: await db.contact.count(),
    projects: await db.project.count(),
    deals: await db.deal.count(),
    opportunities: await db.opportunity.count(),
    tasks: await db.task.count(),
    notes: await db.note.count(),
    activities: await db.activity.count(),
    emails: await db.emailMessage.count(),
    events: await db.calendarEvent.count(),
  };
  console.log("\nSeeded:", counts);
  console.log("\nSign in with  owner@tinycrm.app / tinycrm");
  console.log("Free-plan account:  demo@tinycrm.app / tinycrm\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
