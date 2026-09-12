import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { type Browser, type Page } from "playwright";

import { db } from "../helpers/fixtures";
import { markImported, runnerMark, tracedLaunch } from "./_trace";

/**
 * The invitation journey, in a real browser.
 *
 * The data-layer suite proves the rules. This proves the road: that a person
 * who opens the emailed link can actually reach the workspace, and — the part
 * that matters most — that a brand-new account created from that link does not
 * end up in a workspace of its own.
 *
 * That failure would never show up in a unit test, because it is made of two
 * redirects and a provisioning call in different files agreeing to do the wrong
 * thing. It needs a browser walking the route.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const PASSWORD = "a-long-enough-password-9134";

markImported("team-invite");

let browser: Browser;
const users: string[] = [];
const workspaces: string[] = [];

async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#password", { timeout: 60_000 });
  await page.waitForTimeout(750); // hydration
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/** An owner with a workspace, built the way production builds one. */
async function owner(label: string) {
  const email = `owner-${label}-${randomUUID().slice(0, 8)}@invite.test`.toLowerCase();
  const user = await db.user.create({
    data: {
      email,
      name: `${label} Owner`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true },
  });
  users.push(user.id);

  const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
  const workspace = await provisionWorkspace(user.id, { name: `${label} Studio` });
  workspaces.push(workspace.id);
  return { userId: user.id, email, workspaceId: workspace.id, workspaceName: workspace.name };
}

/** Issues an invitation and returns the link a recipient would click. */
async function inviteLink(workspaceId: string, invitedById: string, email: string) {
  const { issueInvitation } = await import("../../src/lib/auth/invitations");
  const issued = await issueInvitation({ workspaceId, email, role: "member", invitedById });
  return `${BASE_URL}/invite/${encodeURIComponent(issued.token)}`;
}

describe("joining a workspace from an invitation", () => {
  before(async () => {
    runnerMark("before:start", { suite: "team-invite" });
    browser = await tracedLaunch("team-invite");

    // Pay the dev server's first compile of the authenticated shell here,
    // outside any assertion's timeout.
    //
    // The harness warms the public routes, but /settings/team sits behind the
    // signed-out redirect, so an anonymous fetch never reaches the page and
    // never compiles it. The cost then lands inside whichever locator waits
    // first, which is how a 60-second timeout becomes a flake on a loaded
    // machine. Budgeted generously and asserted on nothing: if it is slow, it
    // is slow here rather than mid-test.
    runnerMark("page:create:start", { suite: "team-invite" });
    const warm = await browser.newPage();
    runnerMark("page:create:end", { suite: "team-invite" });

    runnerMark("fixtures:write:start");
    const host = await owner("Warmup");
    runnerMark("fixtures:write:end");

    runnerMark("navigation:first:start", { target: "/login" });
    await signIn(warm, host.email);
    runnerMark("navigation:first:end", { target: "/login" });

    runnerMark("navigation:warm:start", { target: "/settings/team" });
    await warm
      .goto(`${BASE_URL}/settings/team`, { waitUntil: "domcontentloaded", timeout: 300_000 })
      .catch(() => {});
    runnerMark("navigation:warm:end", { target: "/settings/team" });

    await warm.close();
    runnerMark("before:end", { suite: "team-invite" });
  });

  after(async () => {
    await browser?.close();
    if (users.length > 0) {
      await db.workspaceMember.deleteMany({ where: { userId: { in: users } } });
      await db.workspace.deleteMany({ where: { ownerId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
    await db.$disconnect();
  });

  test("a brand-new person signs up from the link and lands in the inviting workspace", async () => {
    runnerMark("test:first:start");
    const host = await owner("Signup");
    const recipient = `new-${randomUUID().slice(0, 8)}@invite.test`.toLowerCase();
    const link = await inviteLink(host.workspaceId, host.userId, recipient);

    const page = await browser.newPage();
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // The page says what is on offer before asking for anything.
    await page.getByRole("heading", { name: `Join ${host.workspaceName}` }).waitFor({ timeout: 60_000 });
    const shown = await page.locator("body").innerText();
    assert.ok(shown.includes(recipient), "the invited address is not shown");
    assert.ok(/Member/i.test(shown), "the offered role is not shown");

    await page.waitForTimeout(750); // hydration
    // The address is fixed to the invitation; only a name and password are needed.
    const email = page.locator("#email");
    assert.equal(await email.inputValue(), recipient, "the email was not pre-filled");
    assert.equal(await email.getAttribute("readonly"), "", "the invited address was editable");

    await page.fill("#name", "Newly Invited");
    await page.fill("#password", PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    // Back on the invitation, now signed in, with one button left to press.
    await page.getByRole("button", { name: `Join ${host.workspaceName}` }).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: `Join ${host.workspaceName}` }).click();
    await page.waitForURL(`${BASE_URL}/home`, { timeout: 60_000 });

    const created = await db.user.findUnique({
      where: { email: recipient },
      select: { id: true },
    });
    assert.ok(created, "no account was created");
    users.push(created.id);

    const memberships = await db.workspaceMember.findMany({
      where: { userId: created.id },
      select: { workspaceId: true, role: true },
    });
    assert.equal(memberships.length, 1, "the new account joined the wrong number of workspaces");
    assert.equal(memberships[0]!.workspaceId, host.workspaceId, "they joined the wrong workspace");
    assert.equal(memberships[0]!.role, "member");

    // The defect this whole ordering exists to prevent.
    const ownWorkspaces = await db.workspace.count({ where: { ownerId: created.id } });
    assert.equal(ownWorkspaces, 0, "signing up from an invitation created a second workspace");

    await page.close();
  });

  test("an existing Tiny user signs in from the link and joins", async () => {
    const host = await owner("Existing");
    const guestEmail = `guest-${randomUUID().slice(0, 8)}@invite.test`.toLowerCase();
    const guest = await db.user.create({
      data: {
        email: guestEmail,
        name: "Existing Guest",
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        emailVerifiedAt: new Date(),
        onboardedAt: new Date(),
      },
      select: { id: true },
    });
    users.push(guest.id);

    const link = await inviteLink(host.workspaceId, host.userId, guestEmail);
    const page = await browser.newPage();
    await signIn(page, guestEmail);

    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(750);
    await page.getByRole("button", { name: `Join ${host.workspaceName}` }).click();
    await page.waitForURL(`${BASE_URL}/home`, { timeout: 60_000 });

    const memberships = await db.workspaceMember.count({
      where: { userId: guest.id, workspaceId: host.workspaceId },
    });
    assert.equal(memberships, 1, "an existing user did not join");
    await page.close();
  });

  test("an owner can invite from Settings → Team and sees the pending row", async () => {
    const host = await owner("Screen");
    const target = `screen-${randomUUID().slice(0, 8)}@invite.test`.toLowerCase();

    const page = await browser.newPage();
    await signIn(page, host.email);
    await page.goto(`${BASE_URL}/settings/team`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#invite-email", { timeout: 60_000 });
    await page.waitForTimeout(750);

    await page.fill("#invite-email", target);
    await page.getByRole("button", { name: "Send invitation" }).click();

    // The row, not just a toast: the toast disappears and the list is the record.
    await page.getByText(target, { exact: false }).first().waitFor({ timeout: 60_000 });

    const row = await db.workspaceInvitation.findFirst({
      where: { workspaceId: host.workspaceId, email: target },
      select: { role: true, scopeMode: true, acceptedAt: true },
    });
    assert.ok(row, "no invitation was written");
    assert.equal(row.role, "member");
    assert.equal(row.scopeMode, "workspace");
    assert.equal(row.acceptedAt, null);
    await page.close();
  });

  test("a link that has been used says so, and gives nothing else away", async () => {
    const host = await owner("Spent");
    const email = `spent-${randomUUID().slice(0, 8)}@invite.test`.toLowerCase();
    const link = await inviteLink(host.workspaceId, host.userId, email);

    // Spend it out of band, then open it.
    const user = await db.user.create({
      data: {
        email,
        name: "Spent Guest",
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    users.push(user.id);
    const token = decodeURIComponent(link.split("/invite/")[1]!);
    const { acceptInvitation } = await import("../../src/lib/auth/invitations");
    const accepted = await acceptInvitation(token, { id: user.id, email });
    assert.equal(accepted.ok, true, "the setup step failed");

    const page = await browser.newPage();
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const body = await page.locator("body").innerText();

    assert.match(body, /no longer valid/i, "a spent link did not say so");
    // One message for every failure: naming the workspace, the inviter or the
    // address would confirm to a stranger that the link once meant something.
    assert.ok(!body.includes(host.workspaceName), "the workspace name leaked to a spent link");
    assert.ok(!body.includes(email), "the invited address leaked to a spent link");
    await page.close();
  });
});
