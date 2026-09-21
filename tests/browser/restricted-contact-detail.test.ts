import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

import { db } from "../helpers/fixtures";

/**
 * A restricted member opening a contact they are entitled to see.
 *
 * Step 3B removes the private half of a contact for a reader who reaches that
 * person only through one piece of work: no relationship score, no importance,
 * no lead source, no internal description, no account owner, no counts. The
 * data layer did that correctly. The page then rendered
 * `contact.relationship.value` unconditionally, and for exactly those readers
 * the render threw — a 500 where the record should have been.
 *
 * It was not a disclosure bug; nothing leaked. It was the opposite failure:
 * the boundary worked and the page could not cope with what it returned. The
 * production canary found it, which is what a canary is for, and the integration
 * tests could not have — they exercised the data function and never rendered
 * the page.
 *
 * So this test renders the page. It signs a real restricted member in and opens
 * a real contact detail URL, because the defect lived entirely between the
 * projection and the markup.
 *
 * Engine note: the projection is application-level — `isRestrictedReader` reads
 * the scope carried on the request, not a policy — so this reproduces on SQLite
 * exactly as it does on PostgreSQL. The row-level rules that decide *which*
 * contacts are reachable are proven separately in tests/security.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const PASSWORD = "a-long-enough-password-5821";

let browser: Browser;
const users: string[] = [];
const workspaces: string[] = [];

/** Everything the page needs, and a second contact the member may not reach. */
const world = {
  ownerEmail: "",
  memberEmail: "",
  reachableContactId: "",
  unreachableContactId: "",
  grantedOpportunityId: "",
};

const SENTINEL = {
  description: "RESTRICTED_RENDER_SENTINEL_INTERNAL_NOTE",
  leadSource: "referral",
};

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  const email = `restricted-${label}-${randomUUID().slice(0, 8)}@render.test`.toLowerCase();
  const user = await db.user.create({
    data: {
      email,
      name: `${label} Person`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true, email: true },
  });
  users.push(user.id);
  return user;
}

before(async () => {
  browser = await chromium.launch();

  const owner = await makeUser("owner");
  const member = await makeUser("member");
  world.ownerEmail = owner.email;
  world.memberEmail = member.email;

  const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
  const workspace = await provisionWorkspace(owner.id, { name: "Restricted Render" });
  workspaces.push(workspace.id);

  const granted = await db.opportunity.create({
    data: { workspaceId: workspace.id, name: "Granted pursuit" },
    select: { id: true },
  });
  const ungranted = await db.opportunity.create({
    data: { workspaceId: workspace.id, name: "Ungranted pursuit" },
    select: { id: true },
  });
  world.grantedOpportunityId = granted.id;

  const contact = async (first: string) =>
    (
      await db.contact.create({
        data: {
          workspaceId: workspace.id,
          firstName: first,
          lastName: "Marchetti",
          fullName: `${first} Marchetti`,
          email: `${first.toLowerCase()}@render.test`,
          jobTitle: "Head of Procurement",
          // The private half. Present in the row, withheld from the reader.
          description: SENTINEL.description,
          leadSource: SENTINEL.leadSource,
          importance: 4,
          ownerId: owner.id,
        },
        select: { id: true },
      })
    ).id;

  world.reachableContactId = await contact("Dana");
  world.unreachableContactId = await contact("Rafi");
  await db.opportunityContact.create({
    data: { opportunityId: granted.id, contactId: world.reachableContactId },
  });
  await db.opportunityContact.create({
    data: { opportunityId: ungranted.id, contactId: world.unreachableContactId },
  });

  // The member joins, is restricted, and is given the one opportunity.
  const membership = await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: member.id, role: "member", scopeMode: "restricted" },
    select: { id: true },
  });
  await db.recordGrant.create({
    data: {
      workspaceId: workspace.id,
      userId: member.id,
      membershipId: membership.id,
      anchorType: "opportunity",
      anchorId: granted.id,
      grantedById: owner.id,
    },
  });
});

after(async () => {
  await browser?.close();
  for (const id of workspaces) await db.workspace.deleteMany({ where: { id } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("a restricted member opening a contact", () => {
  test("the page renders rather than throwing", async () => {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`);
    });

    try {
      await signIn(page, world.memberEmail);
      const response = await page.goto(`${BASE_URL}/contacts/${world.reachableContactId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      assert.equal(
        response?.status(),
        200,
        `the contact detail page returned ${response?.status()} for a member entitled to see it`,
      );
      assert.deepEqual(failures, [], `the page produced server errors: ${failures.join(", ")}`);

      // It is the right record, actually rendered.
      const body = await page.textContent("body");
      assert.ok(body?.includes("Dana Marchetti"), "the contact's name was not rendered");
    } finally {
      await page.close();
    }
  });

  test("the withheld half is absent from what was rendered", async () => {
    const page = await browser.newPage();
    try {
      await signIn(page, world.memberEmail);
      await page.goto(`${BASE_URL}/contacts/${world.reachableContactId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const body = (await page.textContent("body")) ?? "";

      // The score is the field whose absence crashed the page; it must stay
      // absent rather than reappear as a side effect of the fix.
      assert.ok(
        !body.includes("What drives this score"),
        "the relationship score explainer was rendered to a restricted reader",
      );
      assert.ok(
        !body.includes(SENTINEL.description),
        "the internal description was rendered to a restricted reader",
      );
      // The withheld *value*, not the row label. "Lead source" is static
      // chrome: the row renders with an empty value for a restricted reader,
      // which is cosmetic rather than a disclosure. Asserting on the label
      // tested the layout, not the boundary.
      assert.ok(
        !body.includes("Referral"),
        "the lead source value was rendered to a restricted reader",
      );
    } finally {
      await page.close();
    }
  });

  // Deliberately not asserted here: that a contact on ungranted work stays
  // unreachable. This suite runs against SQLite, which has no row-level
  // security, so the row is reachable at the data layer regardless of the
  // grant and the assertion would fail for a reason that has nothing to do
  // with the page. Reachability is decided by policy and is proven where
  // policies exist — tests/security/contact-company-scope.test.ts, "a contact
  // on work they were not given is not readable by id". What belongs here is
  // the render, which is engine-independent.

  test("a full-workspace reader still sees the whole record", async () => {
    // The control. Withholding from one reader must not withhold from everyone.
    const page = await browser.newPage();
    try {
      await signIn(page, world.ownerEmail);
      const response = await page.goto(`${BASE_URL}/contacts/${world.reachableContactId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const body = (await page.textContent("body")) ?? "";

      assert.equal(response?.status(), 200, "the owner could not open the contact");
      assert.ok(body.includes("Dana Marchetti"), "the owner did not see the contact");
      assert.ok(
        body.includes("What drives this score"),
        "the relationship score vanished for a full-workspace reader too",
      );
      assert.ok(
        body.includes("Lead source"),
        "the lead source row vanished for a full-workspace reader too",
      );
    } finally {
      await page.close();
    }
  });
});
