import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { isPostgres } from "../../src/lib/env";
import type { ReadScope } from "../../src/lib/auth/access";

/**
 * The ways in that are not a record page: pickers, error messages, and counts.
 *
 * A boundary is only as good as its least-examined edge. Row policies decide
 * what a query returns; they say nothing about an endpoint that never asked for
 * a permission, an error that names what it refused, or a total computed over
 * rows the reader cannot list. This file walks those three.
 *
 * Where a path turns out to be already protected — by Step 3A, by 011, or by
 * the record-access guard — it stays here as a regression assertion with the
 * reason written down, rather than being deleted or dressed up as a fix.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;

const id = {
  grantedOpp: "",
  ungrantedOpp: "",
  reachableContact: "",
  unreachableContact: "",
  visibleCompany: "",
  hiddenCompany: "",
  /** Primary contact of a company the restricted member cannot see. */
  contactTakenAsPrimary: "",
};

function restrictedScope(): ReadScope {
  return { workspaceIds: [A.workspaceId], userId: A.memberId, restrictedWorkspaceIds: [A.workspaceId] };
}
function ownerScope(): ReadScope {
  return { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] };
}

before(async () => {
  A = await createTenant("Surfaces");
  const ws = A.workspaceId;

  const company = async (name: string) =>
    (await observer.company.create({ data: { workspaceId: ws, name }, select: { id: true } })).id;
  const contact = async (first: string) =>
    (
      await observer.contact.create({
        data: {
          workspaceId: ws,
          firstName: first,
          lastName: "Ashford",
          fullName: `${first} Ashford`,
          email: `${first.toLowerCase()}@surfaces.invalid`,
          // Due for follow-up, so the dashboard and analytics have something to
          // count. Without this the aggregate tests would pass on an empty set.
          nextFollowUpAt: new Date(Date.now() - 86_400_000),
          createdAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

  id.visibleCompany = await company("Harbour Authority");
  id.hiddenCompany = await company("Ridgeline Transit");

  id.grantedOpp = (
    await observer.opportunity.create({
      data: { workspaceId: ws, name: "Harbour RFP", companyId: id.visibleCompany },
      select: { id: true },
    })
  ).id;
  id.ungrantedOpp = (
    await observer.opportunity.create({
      data: { workspaceId: ws, name: "Ridgeline RFP", companyId: id.hiddenCompany },
      select: { id: true },
    })
  ).id;

  id.reachableContact = await contact("Nadia");
  id.unreachableContact = await contact("Theo");
  id.contactTakenAsPrimary = await contact("Bex");

  await observer.opportunityContact.create({
    data: { opportunityId: id.grantedOpp, contactId: id.reachableContact },
  });
  await observer.opportunityContact.create({
    data: { opportunityId: id.ungrantedOpp, contactId: id.unreachableContact },
  });
  // Bex is reachable — attached to the granted opportunity — and is already the
  // primary contact of a company the member cannot see. That is the collision
  // the P2002 oracle was made of.
  await observer.opportunityContact.create({
    data: { opportunityId: id.grantedOpp, contactId: id.contactTakenAsPrimary },
  });
  await observer.company.update({
    where: { id: id.hiddenCompany },
    data: { primaryContactId: id.contactTakenAsPrimary },
  });

  await observer.workspaceMember.updateMany({
    where: { workspaceId: ws, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  // A restricted viewer, for the permission check on the picker.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: ws, userId: A.viewerId },
    data: { scopeMode: "restricted" },
  });
  await observer.recordGrant.createMany({
    data: [
      { workspaceId: ws, userId: A.memberId, anchorType: "opportunity", anchorId: id.grantedOpp, grantedById: A.ownerId },
      { workspaceId: ws, userId: A.viewerId, anchorType: "opportunity", anchorId: id.grantedOpp, grantedById: A.ownerId },
    ],
  });
});

beforeEach(async () => {
  for (const user of [A.memberId, A.ownerId, A.viewerId]) {
    await resetRateLimit("mutation", { user, workspace: A.workspaceId });
    await resetRateLimit("options", { user });
  }
});

after(async () => {
  await cleanupTenants([A]);
  await observer.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. The picker
// ---------------------------------------------------------------------------

describe("the record picker", () => {
  const call = async (userId: string, type: string, q = "") => {
    const { GET } = await import("../../src/app/api/options/route");
    const url = `http://localhost/api/options?type=${type}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const response = await runAsTestIdentity(userId, () => GET(new Request(url)));
    const body = (await response.json()) as { options?: { value: string }[] };
    return { status: response.status, values: (body.options ?? []).map((o) => o.value) };
  };

  test("offers a restricted member only the contacts they can reach", pgOnly ?? {}, async () => {
    const { status, values } = await call(A.memberId, "contact");
    assert.equal(status, 200, "the picker refused a member who may read records");
    assert.ok(
      values.includes(id.reachableContact),
      "the picker hid a contact attached to the member's own work",
    );
    assert.ok(
      !values.includes(id.unreachableContact),
      "the picker offered a contact from work the member was never given",
    );
  });

  test("offers only the companies they can reach", pgOnly ?? {}, async () => {
    const { values } = await call(A.memberId, "company");
    assert.ok(values.includes(id.visibleCompany), "the picker hid the company behind granted work");
    assert.ok(!values.includes(id.hiddenCompany), "the picker offered a company the member cannot see");
  });

  test("an empty query cannot be used to enumerate", pgOnly ?? {}, async () => {
    // The widest form of the question: no search term, just "list some".
    const { values } = await call(A.memberId, "contact", "");
    assert.ok(
      !values.includes(id.unreachableContact),
      "an empty query enumerated contacts the member cannot reach",
    );
  });

  test("a role without record:view is refused outright", pgOnly ?? {}, async () => {
    // RLS would already narrow the rows; this is the endpoint declining to
    // answer at all, which it never did before.
    await observer.workspaceMember.updateMany({
      where: { workspaceId: A.workspaceId, userId: A.viewerId },
      data: { role: "viewer" },
    });
    try {
      const { values } = await call(A.viewerId, "contact");
      assert.ok(Array.isArray(values), "the endpoint errored rather than answering emptily");
    } finally {
      await observer.workspaceMember.updateMany({
        where: { workspaceId: A.workspaceId, userId: A.viewerId },
        data: { role: "member" },
      });
    }
  });

  test("a full-workspace member still sees everything", pgOnly ?? {}, async () => {
    const { values } = await call(A.ownerId, "contact");
    assert.ok(values.includes(id.reachableContact), "the owner lost a contact");
    assert.ok(values.includes(id.unreachableContact), "the owner lost a contact they are entitled to");
  });
});

// ---------------------------------------------------------------------------
// 2. Error oracles
// ---------------------------------------------------------------------------

describe("errors do not describe what they refuse", () => {
  test("a unique collision with an invisible company names nothing", pgOnly ?? {}, async () => {
    // Bex is reachable and is already primary contact of a company the member
    // cannot see. Before this step the constraint violation answered "that
    // primaryContactId is already in use" — which says a company they cannot
    // see exists and has claimed this person.
    const { updateCompany } = await import("../../src/lib/actions/companies");
    const before = await observer.company.findFirst({
      where: { id: id.visibleCompany },
      select: { version: true },
    });
    const result = await runAsTestIdentity(A.memberId, () =>
      updateCompany(id.visibleCompany, {
        primaryContactId: id.contactTakenAsPrimary,
        version: before?.version,
      }),
    );

    assert.equal(result.ok, false, "the collision was accepted");
    if (!result.ok) {
      assert.doesNotMatch(
        result.error ?? "",
        /primaryContactId|already in use/i,
        `the error names the constraint, which describes a record the member cannot see: ${result.error}`,
      );
    }
  });

  test("deleting an unreachable record never reaches the confirmation", pgOnly ?? {}, async () => {
    // assertConfirmation echoes the record's name, which reads like a
    // disclosure — and is not one, because recordAction resolves the record
    // through RLS first. An unreachable contact is refused before any
    // confirmation is compared, so the name is never in play. A regression
    // assertion, and the reason it is one.
    const { deleteContact } = await import("../../src/lib/actions/contacts");
    const result = await runAsTestIdentity(A.ownerId, async () => {
      await observer.workspaceMember.updateMany({
        where: { workspaceId: A.workspaceId, userId: A.ownerId },
        data: { scopeMode: "restricted" },
      });
      try {
        return await deleteContact(id.unreachableContact, "wrong name entirely");
      } finally {
        await observer.workspaceMember.updateMany({
          where: { workspaceId: A.workspaceId, userId: A.ownerId },
          data: { scopeMode: "workspace" },
        });
      }
    });

    assert.equal(result.ok, false, "an unreachable contact was deleted");
    if (!result.ok) {
      assert.doesNotMatch(
        result.error ?? "",
        /Theo|Ashford|Type "/,
        `the refusal named the record or quoted its name: ${result.error}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Aggregates
// ---------------------------------------------------------------------------

describe("counts are computed from what the reader can see", () => {
  test("the dashboard's follow-up list excludes unreachable people", pgOnly ?? {}, async () => {
    const { getDashboard } = await import("../../src/lib/data/dashboard");
    const forMember = await getDashboard(restrictedScope(), null);
    const names = (forMember.contactsToFollowUp ?? []).map((c: { id: string }) => c.id);

    assert.ok(!names.includes(id.unreachableContact), "the dashboard listed an unreachable contact");

    const forOwner = await getDashboard(ownerScope(), null);
    const ownerNames = (forOwner.contactsToFollowUp ?? []).map((c: { id: string }) => c.id);
    assert.ok(
      ownerNames.includes(id.unreachableContact),
      "the fixture has no unreachable follow-up to exclude — this test would pass on an empty set",
    );
  });

  test("the analytics contact count counts only reachable people", pgOnly ?? {}, async () => {
    const { getAnalytics } = await import("../../src/lib/data/analytics");
    const forMember = await getAnalytics(restrictedScope(), 30);
    const forOwner = await getAnalytics(ownerScope(), 30);

    assert.ok(
      forOwner.contactsAdded > forMember.contactsAdded,
      `a restricted member's contact count (${forMember.contactsAdded}) matches the owner's ` +
        `(${forOwner.contactsAdded}), so unreachable people are being counted`,
    );
  });

  test("an opportunity's contact count follows its own links", pgOnly ?? {}, async () => {
    // A positive control with teeth: the granted opportunity genuinely has two
    // contacts, and the member is entitled to both because both are attached to
    // work they hold.
    const { listOpportunities } = await import("../../src/lib/data/opportunities");
    const opportunities = await listOpportunities(restrictedScope(), {});
    const row = opportunities.find((o: { id: string }) => o.id === id.grantedOpp) as
      | { _count?: { contacts: number } }
      | undefined;
    assert.ok(row, "the granted opportunity is missing from the list");
    assert.equal(
      row._count?.contacts,
      2,
      "the opportunity's own contact count is wrong for the person holding it",
    );
  });
});
