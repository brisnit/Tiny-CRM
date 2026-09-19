import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant, membershipIdFor } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { isPostgres } from "../../src/lib/env";
import type { ReadScope } from "../../src/lib/auth/access";

/**
 * Step 3B: what a restricted member may learn about people and organisations.
 *
 * Step 3A confined them to anchors and the records hanging off those anchors.
 * Contacts and companies were left on the workspace rule deliberately, and this
 * is the file that says what that costs: today a member granted one opportunity
 * can still read every contact in the workspace by name, email and phone, every
 * company with its revenue band and its internal description, and can find both
 * through search, through the picker that feeds every form, and through the AI
 * hygiene screens that exist to list duplicates.
 *
 * The rules being proven:
 *
 *   * A Contact is visible only through an OpportunityContact or ProjectContact
 *     row pointing at an anchor the member holds. Being primary contact of a
 *     visible company is not a connection.
 *   * A Company is visible only through a visible Opportunity or Project, and
 *     only as identity: id, name, domain, website, industry, logoUrl, location,
 *     size. Nothing about our relationship with them.
 *   * A visible child that names an invisible contact or company does not
 *     thereby reveal it.
 *
 * Every case drives a real read path or a real server action — listContacts,
 * getCompany, searchEverything, updateContact, setProjectContact — because the
 * last correction turned on exactly this distinction: policies can be right
 * while the application never asks them.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;

const id = {
  grantedOpp: "",
  ungrantedOpp: "",
  grantedProject: "",
  ungrantedProject: "",
  /** Reachable: linked to the granted opportunity. */
  contactOnGrantedOpp: "",
  /** Reachable: linked to the granted project. */
  contactOnGrantedProject: "",
  /** Not reachable: linked only to work they were not given. */
  contactOnUngrantedOpp: "",
  /** Not reachable: linked to nothing at all. */
  contactUnlinked: "",
  /** Not reachable: primary contact of a visible company, per B-2. */
  contactPrimaryOnly: "",
  /** Visible as identity: the granted opportunity's company. */
  companyOnGrantedOpp: "",
  /** Not visible: belongs to work they were not given. */
  companyOnUngrantedOpp: "",
  /** A task inside the granted anchor that names invisible people. */
  taskNamingInvisible: "",
  /**
   * A second connected contact, used only by the tests that attempt writes.
   * The write paths under test currently succeed — that is what they
   * demonstrate — and updateContact recomputes fullName from whatever it was
   * given, so a shared fixture would be rewritten underneath the positive
   * controls and they would fail for a second, unrelated reason.
   */
  contactForWrites: "",
};

/** The restricted member's scope, as resolveReadScope would build it. */
function restrictedScope(): ReadScope {
  return {
    workspaceIds: [A.workspaceId],
    userId: A.memberId,
    restrictedWorkspaceIds: [A.workspaceId],
  };
}

/** A full-workspace member's scope, for the positive controls. */
function ownerScope(): ReadScope {
  return { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] };
}

before(async () => {
  A = await createTenant("CcScope");
  const ws = A.workspaceId;

  const company = async (name: string, extra: Record<string, unknown> = {}) =>
    (
      await observer.company.create({
        data: {
          workspaceId: ws,
          name,
          domain: `${name.toLowerCase().replace(/\W+/g, "")}.example`,
          industry: "Municipal",
          location: "Portland",
          size: "51-200",
          website: "https://example.invalid",
          // The fields a restricted member must never see.
          revenueRange: "$10M-$50M",
          leadSource: "Referral from the mayor's office",
          relationshipStatus: "client",
          type: "client",
          description: "Renewal at risk; the CFO is hostile to the incumbent.",
          ownerId: A.ownerId,
          ...extra,
        },
        select: { id: true },
      })
    ).id;

  const contact = async (first: string, companyId: string | null) =>
    (
      await observer.contact.create({
        data: {
          workspaceId: ws,
          firstName: first,
          lastName: "Whitfield",
          fullName: `${first} Whitfield`,
          jobTitle: "Procurement lead",
          email: `${first.toLowerCase()}@example.invalid`,
          phone: "+1 555 0100",
          companyId,
          description: "Prefers email. Was burned by the last vendor.",
          importance: 5,
          leadSource: "Conference",
          ownerId: A.ownerId,
        },
        select: { id: true },
      })
    ).id;

  id.companyOnGrantedOpp = await company("Riverside Authority");
  id.companyOnUngrantedOpp = await company("Northgate Transit");

  id.grantedOpp = (
    await observer.opportunity.create({
      data: { workspaceId: ws, name: "Riverside RFP", companyId: id.companyOnGrantedOpp },
      select: { id: true },
    })
  ).id;
  id.ungrantedOpp = (
    await observer.opportunity.create({
      data: { workspaceId: ws, name: "Northgate RFP", companyId: id.companyOnUngrantedOpp },
      select: { id: true },
    })
  ).id;
  id.grantedProject = (
    await observer.project.create({
      data: { workspaceId: ws, name: "Riverside delivery", lastActivityAt: new Date() },
      select: { id: true },
    })
  ).id;
  id.ungrantedProject = (
    await observer.project.create({
      data: { workspaceId: ws, name: "Northgate delivery", lastActivityAt: new Date() },
      select: { id: true },
    })
  ).id;

  id.contactOnGrantedOpp = await contact("Dana", id.companyOnGrantedOpp);
  id.contactOnGrantedProject = await contact("Priya", id.companyOnGrantedOpp);
  id.contactOnUngrantedOpp = await contact("Marcus", id.companyOnUngrantedOpp);
  id.contactUnlinked = await contact("Sol", null);
  id.contactPrimaryOnly = await contact("Imogen", id.companyOnGrantedOpp);
  id.contactForWrites = await contact("Wren", id.companyOnGrantedOpp);

  await observer.opportunityContact.create({
    data: { opportunityId: id.grantedOpp, contactId: id.contactOnGrantedOpp },
  });
  await observer.projectContact.create({
    data: { projectId: id.grantedProject, contactId: id.contactOnGrantedProject },
  });
  await observer.opportunityContact.create({
    data: { opportunityId: id.ungrantedOpp, contactId: id.contactOnUngrantedOpp },
  });
  await observer.opportunityContact.create({
    data: { opportunityId: id.grantedOpp, contactId: id.contactForWrites },
  });
  // Primary contact of the *visible* company, and connected to no anchor.
  await observer.company.update({
    where: { id: id.companyOnGrantedOpp },
    data: { primaryContactId: id.contactPrimaryOnly },
  });

  // A deal on the visible company and links from the visible contact into work
  // the member was not given. Without these, the two tests below would pass on
  // an empty fixture — "nothing was disclosed" and "there was nothing to
  // disclose" are not the same result.
  await observer.deal.create({
    data: {
      workspaceId: ws,
      name: "Riverside renewal",
      companyId: id.companyOnGrantedOpp,
      pipelineId: A.pipelineId,
      stageId: A.stageId,
      valueCents: 4_800_000,
      updatedAt: new Date(),
    },
  });
  await observer.dealContact.create({
    data: {
      dealId: (await observer.deal.findFirstOrThrow({
        where: { workspaceId: ws, name: "Riverside renewal" },
        select: { id: true },
      })).id,
      contactId: id.contactOnGrantedOpp,
    },
  });
  await observer.projectContact.create({
    data: { projectId: id.ungrantedProject, contactId: id.contactOnGrantedOpp },
  });

  // A task inside the granted anchor that names people the member cannot reach.
  id.taskNamingInvisible = (
    await observer.task.create({
      data: {
        workspaceId: ws,
        title: "Chase the Northgate paperwork",
        opportunityId: id.grantedOpp,
        contactId: id.contactOnUngrantedOpp,
        companyId: id.companyOnUngrantedOpp,
      },
      select: { id: true },
    })
  ).id;

  // Tags and a custom field value on records the member cannot reach.
  await observer.tagLink.create({
    data: { workspaceId: ws, tagId: A.tagId, entityType: "contact", entityId: id.contactOnUngrantedOpp },
  });
  await observer.tagLink.create({
    data: { workspaceId: ws, tagId: A.tagId, entityType: "company", entityId: id.companyOnUngrantedOpp },
  });
  const field = await observer.customFieldDef.create({
    data: { workspaceId: ws, entityType: "contact", key: "cc_probe", label: "Probe", type: "text" },
    select: { id: true },
  });
  await observer.customFieldValue.create({
    data: {
      workspaceId: ws,
      fieldId: field.id,
      entityType: "contact",
      entityId: id.contactOnUngrantedOpp,
      value: "private note about Marcus",
      updatedAt: new Date(),
    },
  });

  // The member is restricted and holds one opportunity and one project.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: ws, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  // A second restricted person, at manager rank, for the paths a member cannot
  // reach at all: export and permanent deletion.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: ws, userId: A.viewerId },
    data: { scopeMode: "restricted", role: "manager" },
  });
  const memberMembership = await membershipIdFor(ws, A.memberId);
  const viewerMembership = await membershipIdFor(ws, A.viewerId);
  await observer.recordGrant.createMany({
    data: [
      { workspaceId: ws, userId: A.memberId, membershipId: memberMembership, anchorType: "opportunity", anchorId: id.grantedOpp, grantedById: A.ownerId },
      { workspaceId: ws, userId: A.memberId, membershipId: memberMembership, anchorType: "project", anchorId: id.grantedProject, grantedById: A.ownerId },
      { workspaceId: ws, userId: A.viewerId, membershipId: viewerMembership, anchorType: "opportunity", anchorId: id.grantedOpp, grantedById: A.ownerId },
    ],
  });
});

beforeEach(async () => {
  for (const user of [A.memberId, A.ownerId, A.viewerId]) {
    await resetRateLimit("mutation", { user, workspace: A.workspaceId });
    await resetRateLimit("ai", { user, workspace: A.workspaceId });
    await resetRateLimit("export", { user, workspace: A.workspaceId });
  }
});

after(async () => {
  await cleanupTenants([A]);
  await observer.$disconnect();
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

describe("a contact is visible only through a connection to granted work", () => {
  test("the contacts list holds exactly the connected people", pgOnly ?? {}, async () => {
    const { listContacts } = await import("../../src/lib/data/contacts");
    const { contacts } = await listContacts(restrictedScope(), {});
    const ids = contacts.map((c) => c.id).sort();
    assert.deepEqual(
      ids,
      [id.contactOnGrantedOpp, id.contactOnGrantedProject, id.contactForWrites].sort(),
      "the contacts list is not exactly the people connected to granted work",
    );
  });

  test("a contact on work they were not given is not readable by id", pgOnly ?? {}, async () => {
    const { getContact } = await import("../../src/lib/data/contacts");
    const seen = await getContact(restrictedScope(), id.contactOnUngrantedOpp);
    assert.equal(seen, null, "a contact from an ungranted opportunity was readable");
  });

  test("a contact connected to nothing is invisible", pgOnly ?? {}, async () => {
    const { getContact } = await import("../../src/lib/data/contacts");
    assert.equal(await getContact(restrictedScope(), id.contactUnlinked), null, "an unconnected contact was readable");
  });

  test("being a visible company's primary contact is not a connection", pgOnly ?? {}, async () => {
    // B-2: the company is visible as identity; that does not hand over its
    // primary contact, who is connected to no anchor the member holds.
    const { getContact } = await import("../../src/lib/data/contacts");
    assert.equal(
      await getContact(restrictedScope(), id.contactPrimaryOnly),
      null,
      "a company's primary contact became visible through the company",
    );
  });

  test("the count beside the list does not betray the rest", pgOnly ?? {}, async () => {
    const { listContacts } = await import("../../src/lib/data/contacts");
    const { total } = await listContacts(restrictedScope(), {});
    assert.equal(total, 3, `the contacts total is ${total}, which counts people the member cannot see`);
  });
});

describe("a visible contact discloses nothing beyond itself", () => {
  test("no relationship counts, no scoring, no private fields", pgOnly ?? {}, async () => {
    const { getContact } = await import("../../src/lib/data/contacts");
    const seen = (await getContact(restrictedScope(), id.contactOnGrantedOpp)) as Record<string, unknown> | null;
    assert.ok(seen, "the connected contact should be readable");

    for (const field of ["description", "importance", "leadSource", "ownerId"]) {
      assert.equal(
        seen[field] ?? null,
        null,
        `a restricted member received Contact.${field}, which describes our relationship rather than the person`,
      );
    }
    assert.equal(seen._count ?? null, null, "relationship counts reached a restricted member");
    assert.equal(seen.owner ?? null, null, "the owning colleague was disclosed");
  });

  test("their other work is not listed through them — already closed by Step 3A", pgOnly ?? {}, async () => {
    // Investigated rather than assumed. The fixture gives this contact a deal
    // and a link into a project the member was never granted, and the owner
    // receives both — so there is genuinely something here to disclose.
    //
    // A restricted member receives neither, and not because of anything in
    // this step: Deal is denied to restricted members outright, DealContact
    // inherits that through its parent, and ProjectContact is anchor-gated by
    // 010. This is therefore a regression assertion, not a red test. It fails
    // the day either of those two rules is weakened.
    const { getContact } = await import("../../src/lib/data/contacts");

    const forOwner = (await getContact(ownerScope(), id.contactOnGrantedOpp)) as Record<string, unknown> | null;
    assert.equal((forOwner?.deals as unknown[])?.length, 1, "the fixture has no deal to disclose");
    assert.equal((forOwner?.projects as unknown[])?.length, 1, "the fixture has no cross-anchor project to disclose");

    const seen = (await getContact(restrictedScope(), id.contactOnGrantedOpp)) as Record<string, unknown> | null;
    assert.ok(seen, "the connected contact should still be readable");
    assert.deepEqual(seen.deals, [], "a contact's deals were listed to a restricted member");
    assert.deepEqual(seen.projects, [], "a contact's other work was listed to a restricted member");
  });
});

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

describe("a company is visible only through visible work, and only as identity", () => {
  // The approved eight, plus workspaceId — the tenant key the reader already
  // knows, carried for server components and named separately in
  // src/lib/data/restricted.ts rather than folded into the identity list.
  const SAFE = [
    "id", "name", "domain", "website", "industry", "logoUrl", "location", "size",
    "workspaceId",
    // A discriminant so callers must branch, not data about the company.
    "identityOnly",
  ];

  test("the company behind granted work is readable", pgOnly ?? {}, async () => {
    const { getCompany } = await import("../../src/lib/data/companies");
    const seen = await getCompany(restrictedScope(), id.companyOnGrantedOpp);
    assert.ok(seen, "the company behind the granted opportunity should be readable");
  });

  test("a company behind work they were not given is not", pgOnly ?? {}, async () => {
    const { getCompany } = await import("../../src/lib/data/companies");
    assert.equal(
      await getCompany(restrictedScope(), id.companyOnUngrantedOpp),
      null,
      "a company from an ungranted opportunity was readable",
    );
  });

  test("only the approved identity fields come back", pgOnly ?? {}, async () => {
    const { getCompany } = await import("../../src/lib/data/companies");
    const seen = (await getCompany(restrictedScope(), id.companyOnGrantedOpp)) as Record<string, unknown> | null;
    assert.ok(seen, "the visible company should be readable");

    const leaked = Object.keys(seen).filter((k) => !SAFE.includes(k));
    assert.deepEqual(
      leaked,
      [],
      `a restricted member received Company fields outside the identity projection: ${leaked.join(", ")}`,
    );
  });

  test("the commercially sensitive fields are absent by name", pgOnly ?? {}, async () => {
    // Named individually so a failure says which one, and so the list is a
    // readable statement of what "identity only" means.
    const { getCompany } = await import("../../src/lib/data/companies");
    const seen = (await getCompany(restrictedScope(), id.companyOnGrantedOpp)) as Record<string, unknown> | null;
    for (const field of [
      "revenueRange", "leadSource", "relationshipStatus", "type", "description",
      "ownerId", "primaryContactId", "lastActivityAt",
    ]) {
      assert.equal(seen?.[field] ?? null, null, `Company.${field} reached a restricted member`);
    }
    assert.equal(seen?._count ?? null, null, "company relationship counts reached a restricted member");
    assert.equal(seen?.primaryContact ?? null, null, "the primary contact was disclosed through the company");
  });

  test("the companies list holds only companies behind granted work", pgOnly ?? {}, async () => {
    const { listCompanies } = await import("../../src/lib/data/companies");
    const { companies, total } = await listCompanies(restrictedScope(), {});
    assert.deepEqual(
      companies.map((c) => c.id),
      [id.companyOnGrantedOpp],
      "the companies list is not exactly those behind granted work",
    );
    assert.equal(total, 1, `the companies total is ${total}`);
  });

  test("no pipeline value is attributed to a visible company — already closed by Step 3A", pgOnly ?? {}, async () => {
    // Same investigation, same answer. The company carries an open deal worth
    // $48,000 and the owner's list reports it; a restricted member's does not,
    // because the groupBy behind that number reads Deal, which they may not
    // see at all. A regression assertion for the Deal denial, reached through
    // an aggregate rather than a row.
    const { listCompanies } = await import("../../src/lib/data/companies");

    const forOwner = await listCompanies(ownerScope(), {});
    const ownerRow = forOwner.companies.find((c) => c.id === id.companyOnGrantedOpp) as Record<string, unknown> | undefined;
    const ownerPipeline = (ownerRow?.pipeline ?? null) as { value?: number; count?: number } | null;
    assert.equal(ownerPipeline?.value, 4_800_000, "the fixture has no pipeline value to disclose");

    const { companies } = await listCompanies(restrictedScope(), {});
    const row = companies.find((c) => c.id === id.companyOnGrantedOpp) as Record<string, unknown> | undefined;
    assert.ok(row, "the visible company is missing from the list");
    const pipeline = (row.pipeline ?? null) as { value?: number; count?: number } | null;
    assert.ok(
      !pipeline || ((pipeline.value ?? 0) === 0 && (pipeline.count ?? 0) === 0),
      `deal pipeline was attributed to a company for a restricted member: ${JSON.stringify(pipeline)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Indirect references through otherwise-visible children
// ---------------------------------------------------------------------------

describe("a visible child does not hand over the people it names", () => {
  test("a visible child does not carry the people it names", pgOnly ?? {}, async () => {
    // Investigated rather than assumed. RLS nulls the joined contact and
    // company on an otherwise-visible task, which is the disclosure that
    // mattered. It cannot null the raw contactId/companyId columns — they sit
    // on a row the member may read — so the question is whether any
    // application path returns them. None does, and the next test keeps it
    // that way.
    const { db } = await import("../../src/lib/db");
    const { withTenantContext } = await import("../../src/lib/tenant-db");

    const task = await withTenantContext(restrictedScope(), async () =>
      db.task.findFirst({
        where: { id: id.taskNamingInvisible },
        select: {
          id: true,
          contact: { select: { id: true, fullName: true } },
          company: { select: { id: true, name: true } },
        },
      }),
    );

    assert.ok(task, "the task inside the granted anchor should still be readable");
    assert.equal(task.contact, null, "the task disclosed a contact the member cannot reach");
    assert.equal(task.company, null, "the task disclosed a company the member cannot reach");
  });

  test("no read path returns a child's raw contact or company id", pgOnly ?? {}, async () => {
    // The other half of B-3, as a source assertion because that is where the
    // rule actually lives: a child reference must never become a visibility
    // edge, and the only way it could is a query selecting the scalar and
    // handing it to a page.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "generated") walk(full);
        } else if (/\.tsx?$/.test(entry)) {
          const source = readFileSync(full, "utf8");
          // contacts.ts scores relationships from DealContact rows keyed to
          // contact ids the caller already holds; that is not a disclosure.
          if (full.endsWith("src/lib/data/contacts.ts")) continue;
          if (/\b(contactId|companyId):\s*true/.test(source)) offenders.push(full);
        }
      }
    };
    // Read and render surfaces only. Server actions select these ids for their
    // own bookkeeping — logging an activity against the company a contact was
    // just filed under — and never hand them to a page.
    walk("src/lib/data");
    walk("src/app");

    assert.deepEqual(
      offenders,
      [],
      `these read paths select a raw contact or company id, which can name a record the reader cannot see:\n` +
        offenders.map((f) => `  ${f}`).join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Search, pickers, aggregates
// ---------------------------------------------------------------------------

describe("the ways in that are not the record itself", () => {
  test("search returns no unreachable contact or company", pgOnly ?? {}, async () => {
    const { searchEverything } = await import("../../src/lib/data/search");
    const hits = await searchEverything(restrictedScope(), "Whitfield");
    const contactIds = hits.filter((h) => h.type === "contact").map((h) => h.id).sort();
    assert.deepEqual(
      contactIds,
      [id.contactOnGrantedOpp, id.contactOnGrantedProject, id.contactForWrites].sort(),
      "search returned contacts the member cannot reach",
    );

    const companyHits = await searchEverything(restrictedScope(), "Northgate");
    assert.deepEqual(
      companyHits.filter((h) => h.type === "company").map((h) => h.id),
      [],
      "search returned a company behind work the member was not given",
    );
  });

  test("the picker that feeds every form offers only reachable records", pgOnly ?? {}, async () => {
    // /api/options is the widest surface: no permission check, and an empty
    // query returns the most recently touched records in the workspace.
    const { db } = await import("../../src/lib/db");
    const { withTenantContext } = await import("../../src/lib/tenant-db");

    const [contacts, companies] = await withTenantContext(restrictedScope(), async () => [
      await db.contact.findMany({ where: { archivedAt: null }, select: { id: true }, take: 20 }),
      await db.company.findMany({ where: { archivedAt: null }, select: { id: true }, take: 20 }),
    ]);

    assert.deepEqual(
      contacts.map((c) => c.id).sort(),
      [id.contactOnGrantedOpp, id.contactOnGrantedProject, id.contactForWrites].sort(),
      "the contact picker offered people the member cannot reach",
    );
    assert.deepEqual(
      companies.map((c) => c.id),
      [id.companyOnGrantedOpp],
      "the company picker offered organisations the member cannot reach",
    );
  });

  test("tags and custom field values on unreachable records stay hidden", pgOnly ?? {}, async () => {
    const { db } = await import("../../src/lib/db");
    const { withTenantContext } = await import("../../src/lib/tenant-db");

    const [tags, values] = await withTenantContext(restrictedScope(), async () => [
      await db.tagLink.findMany({
        where: { entityType: { in: ["contact", "company"] } },
        select: { entityId: true },
      }),
      await db.customFieldValue.findMany({ where: { entityType: "contact" }, select: { value: true } }),
    ]);

    assert.deepEqual(
      tags.map((t) => t.entityId),
      [],
      "a tag disclosed a contact or company the member cannot reach",
    );
    assert.deepEqual(values, [], "a custom field value disclosed data about an unreachable contact");
  });
});

// ---------------------------------------------------------------------------
// The oracles: AI hygiene surfaces and export
// ---------------------------------------------------------------------------

describe("surfaces that exist to enumerate records are refused", () => {
  test("cleanup suggestions are refused for a restricted member", pgOnly ?? {}, async () => {
    const { getCleanupSuggestions } = await import("../../src/lib/actions/ai");
    const result = await runAsTestIdentity(A.memberId, () => getCleanupSuggestions(A.workspaceId));
    assert.equal(
      result.ok,
      false,
      "duplicate detection listed workspace records to a restricted member",
    );
  });

  test("pasted-text classification is refused for a restricted member", pgOnly ?? {}, async () => {
    // classifyText answers "does a contact or company by this name exist?" for
    // arbitrary text. That is an existence oracle by design.
    const { analyzeText } = await import("../../src/lib/actions/ai");
    const result = await runAsTestIdentity(A.memberId, () =>
      analyzeText("Marcus Whitfield at Northgate Transit called about the bid", A.workspaceId),
    );
    assert.equal(result.ok, false, "a restricted member probed the workspace by pasting a name");
  });

  test("export is refused for a restricted manager", pgOnly ?? {}, async () => {
    // A restricted *member* lacks record:export anyway; the case that matters
    // is someone who holds the permission and is still confined.
    const { exportCsv } = await import("../../src/lib/actions/import-export");
    const result = await runAsTestIdentity(A.viewerId, () => exportCsv("contacts", A.workspaceId));
    assert.equal(result.ok, false, "a restricted manager exported the workspace's contacts");
  });
});

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

describe("writes cannot reach the people they cannot see", () => {
  test("an unreachable contact cannot be attached to granted work", pgOnly ?? {}, async () => {
    // The sharpest write path: attaching makes the contact visible, so if this
    // succeeds a restricted member can grant themselves any contact.
    const { setProjectContact } = await import("../../src/lib/actions/projects");
    const result = await runAsTestIdentity(A.memberId, () =>
      setProjectContact(id.grantedProject, id.contactOnUngrantedOpp, true),
    );
    assert.equal(result.ok, false, "a restricted member attached an unreachable contact to their project");

    const link = await observer.projectContact.findFirst({
      where: { projectId: id.grantedProject, contactId: id.contactOnUngrantedOpp },
    });
    assert.equal(link, null, "the link row was written anyway");
  });

  test("a visible contact cannot be re-parented onto an unreachable company", pgOnly ?? {}, async () => {
    const { updateContact } = await import("../../src/lib/actions/contacts");
    const before = await observer.contact.findFirst({
      where: { id: id.contactForWrites },
      select: { companyId: true, version: true, firstName: true, lastName: true, fullName: true },
    });
    const result = await runAsTestIdentity(A.memberId, () =>
      updateContact(id.contactForWrites, {
        companyId: id.companyOnUngrantedOpp,
        version: before?.version,
      }),
    );

    const after = await observer.contact.findFirst({
      where: { id: id.contactForWrites },
      select: { companyId: true },
    });
    // Restored before asserting: while this is red the write succeeds, and
    // updateContact rebuilds fullName from what it was given — so an
    // unrestored fixture would break the positive controls that follow.
    await observer.contact.update({
      where: { id: id.contactForWrites },
      data: {
        companyId: before?.companyId ?? null,
        firstName: before?.firstName ?? "Wren",
        lastName: before?.lastName ?? "Whitfield",
        fullName: before?.fullName ?? "Wren Whitfield",
      },
    });

    assert.equal(result.ok, false, "a restricted member moved a contact to a company they cannot see");
    assert.equal(after?.companyId, before?.companyId, "the contact was re-parented anyway");
  });

  test("a visible company cannot be pointed at an unreachable contact", pgOnly ?? {}, async () => {
    const { updateCompany } = await import("../../src/lib/actions/companies");
    const before = await observer.company.findFirst({
      where: { id: id.companyOnGrantedOpp },
      select: { primaryContactId: true, version: true },
    });
    const result = await runAsTestIdentity(A.memberId, () =>
      updateCompany(id.companyOnGrantedOpp, {
        primaryContactId: id.contactOnUngrantedOpp,
        version: before?.version,
      }),
    );
    await observer.company.update({
      where: { id: id.companyOnGrantedOpp },
      data: { primaryContactId: before?.primaryContactId ?? null },
    });
    assert.equal(result.ok, false, "a restricted member made an unreachable contact a company's primary");
  });

  test("a stale version on an unreachable record reads as not found", pgOnly ?? {}, async () => {
    // assertVersion answers "conflict" when a version is supplied and nothing
    // matched — which, for an invisible row, says it exists.
    const { updateContact } = await import("../../src/lib/actions/contacts");
    const result = await runAsTestIdentity(A.memberId, () =>
      updateContact(id.contactOnUngrantedOpp, { jobTitle: "Renamed", version: 0 }),
    );
    assert.equal(result.ok, false, "a restricted member edited an unreachable contact");
    if (!result.ok) {
      assert.doesNotMatch(
        result.error ?? "",
        /someone else|changed this|conflict/i,
        `the error distinguishes an invisible record from a missing one: ${result.error}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Positive controls
// ---------------------------------------------------------------------------

describe("the work they were given still works", () => {
  test("a connected contact is readable, with the fields the job needs", pgOnly ?? {}, async () => {
    const { getContact } = await import("../../src/lib/data/contacts");
    const seen = (await getContact(restrictedScope(), id.contactOnGrantedOpp)) as Record<string, unknown> | null;
    assert.ok(seen, "the connected contact should be readable");
    assert.equal(seen.fullName, "Dana Whitfield", "the contact's name is missing");
    assert.equal(seen.email, "dana@example.invalid", "the contact's email is missing");
    assert.equal(seen.jobTitle, "Procurement lead", "the contact's job title is missing");
  });

  test("the company behind their work reads as identity", pgOnly ?? {}, async () => {
    const { getCompany } = await import("../../src/lib/data/companies");
    const seen = (await getCompany(restrictedScope(), id.companyOnGrantedOpp)) as Record<string, unknown> | null;
    assert.equal(seen?.name, "Riverside Authority", "the company's name is missing");
    assert.equal(seen?.industry, "Municipal", "the company's industry is missing");
    assert.equal(seen?.location, "Portland", "the company's location is missing");
    assert.equal(seen?.size, "51-200", "the company's size is missing");
  });

  test("a note can still be written inside their own anchor", pgOnly ?? {}, async () => {
    const { createNote } = await import("../../src/lib/actions/notes");
    const result = await runAsTestIdentity(A.memberId, () =>
      createNote({
        workspaceId: A.workspaceId,
        title: "Call summary",
        body: "Spoke to Dana about the submission.",
        opportunityId: id.grantedOpp,
      }),
    );
    assert.equal(result.ok, true, `a restricted member cannot write inside their own anchor: ${result.ok ? "" : result.error}`);
    if (result.ok && result.data) await observer.note.delete({ where: { id: result.data.id } });
  });
});

describe("full-workspace members are unaffected", () => {
  test("the owner still sees every contact and company", pgOnly ?? {}, async () => {
    const { listContacts } = await import("../../src/lib/data/contacts");
    const { listCompanies } = await import("../../src/lib/data/companies");
    const { contacts, total } = await listContacts(ownerScope(), {});
    const { companies } = await listCompanies(ownerScope(), {});
    assert.ok(contacts.length >= 5, `the owner sees ${contacts.length} contacts`);
    assert.ok(total >= 5, `the owner's contact total is ${total}`);
    assert.ok(companies.length >= 2, `the owner sees ${companies.length} companies`);
  });

  test("the owner still receives the full company record", pgOnly ?? {}, async () => {
    const { getCompany } = await import("../../src/lib/data/companies");
    const seen = (await getCompany(ownerScope(), id.companyOnGrantedOpp)) as Record<string, unknown> | null;
    assert.equal(seen?.revenueRange, "$10M-$50M", "a full member lost fields they are entitled to");
    assert.equal(
      seen?.description,
      "Renewal at risk; the CFO is hostile to the incumbent.",
      "a full member lost the company description",
    );
  });

  test("the owner can still attach any contact to any project", pgOnly ?? {}, async () => {
    const { setProjectContact } = await import("../../src/lib/actions/projects");
    const result = await runAsTestIdentity(A.ownerId, () =>
      setProjectContact(id.ungrantedProject, id.contactUnlinked, true),
    );
    assert.equal(result.ok, true, "a full-workspace member lost the ability to link contacts");
    await observer.projectContact.deleteMany({
      where: { projectId: id.ungrantedProject, contactId: id.contactUnlinked },
    });
  });
});
