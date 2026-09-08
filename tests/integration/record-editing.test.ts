import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Correcting a record, and connecting it to a project.
 *
 * Every `update*` action already existed — with authorization, validation,
 * relation checks and audit — and none of it could be reached. The record pages
 * offered Archive and Delete permanently, so fixing a mistyped deal value meant
 * deleting the deal and starting again. `RecordActions` even had an `onEdit`
 * prop that no page ever passed.
 *
 * The same gap hid the product's differentiator. `createDeal` and `updateDeal`
 * both accepted `projectId` and validated it; the form simply never offered the
 * field, so a project's People and Deals panels could not be filled by anyone.
 *
 * These assert the round trip a customer actually performs — create, correct,
 * read it back — and that relationships can be set, changed and removed.
 */

let A: Tenant;
const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

describe("records can be corrected after they are created", () => {
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  test("setup", async () => {
    A = await createTenant("Editing");
    assert.ok(A.dealId);
  });

  test("a deal's value and name survive a correction", async () => {
    const { updateDeal } = await import("../../src/lib/actions/deals");
    const before = await db.deal.findUniqueOrThrow({ where: { id: A.dealId }, select: { version: true } });

    const result = await asOwner(() =>
      updateDeal(A.dealId, { version: before.version, name: "Oakfield — corrected", valueCents: "1450" }),
    );
    assert.equal(result.ok, true, `edit failed: ${JSON.stringify(result)}`);

    const after = await db.deal.findUniqueOrThrow({
      where: { id: A.dealId },
      select: { name: true, valueCents: true, workspaceId: true },
    });
    assert.equal(after.name, "Oakfield — corrected");
    assert.equal(after.valueCents, 145_000, "the corrected value did not persist");
    assert.equal(after.workspaceId, A.workspaceId, "editing moved the record out of its workspace");
  });

  test("a deal can be attached to a project, moved, and detached", async () => {
    const { updateDeal } = await import("../../src/lib/actions/deals");
    const { createProject } = await import("../../src/lib/actions/projects");

    const one = await asOwner(() => createProject({ workspaceId: A.workspaceId, name: "Oakfield garden" }));
    const two = await asOwner(() => createProject({ workspaceId: A.workspaceId, name: "Ridgeline planting" }));
    assert.equal(one.ok && two.ok, true, "could not create the projects to link to");
    const projectOne = (one as { data: { id: string } }).data.id;
    const projectTwo = (two as { data: { id: string } }).data.id;

    const v = async () => (await db.deal.findUniqueOrThrow({ where: { id: A.dealId }, select: { version: true } })).version;
    const projectOf = async () =>
      (await db.deal.findUniqueOrThrow({ where: { id: A.dealId }, select: { projectId: true } })).projectId;

    let version = await v();
    await asOwner(() => updateDeal(A.dealId, { version, projectId: projectOne }));
    assert.equal(await projectOf(), projectOne, "the deal did not attach to the project");

    // Changing it must move the deal, not add a second link.
    version = await v();
    await asOwner(() => updateDeal(A.dealId, { version, projectId: projectTwo }));
    assert.equal(await projectOf(), projectTwo, "the deal did not move between projects");

    // And removing it must be possible, or a mistake is permanent.
    version = await v();
    await asOwner(() => updateDeal(A.dealId, { version, projectId: null }));
    assert.equal(await projectOf(), null, "the deal could not be detached from the project");
  });

  test("a contact's details survive a correction", async () => {
    const { updateContact } = await import("../../src/lib/actions/contacts");
    const contact = await db.contact.findFirstOrThrow({
      where: { workspaceId: A.workspaceId },
      select: { id: true, version: true },
    });
    const result = await asOwner(() =>
      updateContact(contact.id, { version: contact.version, email: "corrected@example.test", jobTitle: "Owner" }),
    );
    assert.equal(result.ok, true, `edit failed: ${JSON.stringify(result)}`);
    const after = await db.contact.findUniqueOrThrow({
      where: { id: contact.id },
      select: { email: true, jobTitle: true },
    });
    assert.equal(after.email, "corrected@example.test");
    assert.equal(after.jobTitle, "Owner");
  });

  test("a stale version is refused rather than silently overwriting", async () => {
    // Two people editing the same record must not clobber one another. The
    // update actions already enforced this; it would be easy to lose while
    // wiring a form, so it is asserted from the caller's side.
    const { updateDeal } = await import("../../src/lib/actions/deals");
    const current = await db.deal.findUniqueOrThrow({ where: { id: A.dealId }, select: { version: true } });
    const stale = current.version - 1;
    const result = await asOwner(() => updateDeal(A.dealId, { version: stale, name: "Written from a stale form" }));
    assert.equal(result.ok, false, "a stale edit was accepted and overwrote a newer one");
  });

  test("every record page offers the edit control", () => {
    // The actions menu always had an `onEdit` prop; no page passed it, so the
    // only options were Archive and Delete permanently. Structural, because a
    // server component cannot be rendered from node:test.
    for (const page of ["deals", "contacts", "companies", "projects", "opportunities"]) {
      const source = read(`src/app/(app)/${page}/[id]/page.tsx`);
      assert.match(
        source,
        /RecordHeaderActions/,
        `${page}/[id] renders no edit control, so its records cannot be corrected`,
      );
    }
  });

  test("the deal and opportunity forms offer a project", () => {
    // Both actions accepted projectId all along. Without the field, Project
    // Intelligence's Deals panel could never be populated by a user.
    const quickAdd = read("src/components/app/quick-add.tsx");
    const dealCase = quickAdd.slice(quickAdd.indexOf('case "deal":'), quickAdd.indexOf('case "project":'));
    assert.match(dealCase, /type="project"/, "the deal form has no project picker");
    const oppCase = quickAdd.slice(quickAdd.indexOf('case "opportunity":'), quickAdd.indexOf('case "meeting":'));
    assert.match(oppCase, /type="project"/, "the opportunity form has no project picker");
  });

  test("a person can be attached to a project and removed again", async () => {
    // ProjectContact was in the schema from the start with nothing ever writing
    // to it, so a project's People panel could not be filled by anyone.
    const { setProjectContact } = await import("../../src/lib/actions/projects");
    // Reuses a project rather than creating one: the Free plan allows three,
    // and this suite already made them.
    const { id: projectId } = await db.project.findFirstOrThrow({
      where: { workspaceId: A.workspaceId },
      select: { id: true },
    });
    await db.projectContact.deleteMany({ where: { projectId } });
    const contact = await db.contact.findFirstOrThrow({
      where: { workspaceId: A.workspaceId },
      select: { id: true },
    });

    const attach = await asOwner(() => setProjectContact(projectId, contact.id, true));
    assert.equal(attach.ok, true, `attach failed: ${JSON.stringify(attach)}`);
    assert.equal(
      await db.projectContact.count({ where: { projectId, contactId: contact.id } }),
      1,
      "the contact was not attached to the project",
    );

    // Attaching twice must not duplicate — the panel would show the person twice.
    await asOwner(() => setProjectContact(projectId, contact.id, true));
    assert.equal(await db.projectContact.count({ where: { projectId } }), 1, "attaching twice created a duplicate");

    const detach = await asOwner(() => setProjectContact(projectId, contact.id, false));
    assert.equal(detach.ok, true);
    assert.equal(await db.projectContact.count({ where: { projectId } }), 0, "the contact could not be removed");
  });

  test("a contact from another workspace cannot be attached", async () => {
    // Same shape as every other cross-tenant reference: refused as missing,
    // not as forbidden, so the answer does not confirm the id exists.
    const B = await createTenant("PeopleOther");
    try {
      const { setProjectContact } = await import("../../src/lib/actions/projects");
      const { id: projectId } = await db.project.findFirstOrThrow({
        where: { workspaceId: A.workspaceId },
        select: { id: true },
      });
      const theirs = await db.contact.findFirstOrThrow({
        where: { workspaceId: B.workspaceId },
        select: { id: true },
      });

      const result = await asOwner(() => setProjectContact(projectId, theirs.id, true));
      assert.equal(result.ok, false, "a contact from another workspace was attached to this project");
      assert.equal(
        await db.projectContact.count({ where: { projectId, contactId: theirs.id } }),
        0,
        "CROSS-TENANT LEAK: the link was written anyway",
      );
    } finally {
      await cleanupTenants([B]);
    }
  });
});
