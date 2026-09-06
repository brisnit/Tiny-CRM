import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Tenant-escape tests.
 *
 * Every test here plays the same attacker: a legitimate, authenticated member of
 * Workspace A who substitutes an id belonging to Workspace B. These are the
 * regression tests for audit findings F-02 and F-03 — a whole class of writes
 * that trusted client-supplied foreign keys.
 *
 * The suite is deliberately exhaustive across entity types rather than
 * representative. The prototype's bug was not that one action forgot the check;
 * it was that *no* action performed it, and a per-entity test is what catches
 * the next action that forgets.
 */

let A: Tenant;
let B: Tenant;

describe("tenant isolation", () => {
  before(async () => {
    A = await createTenant("Alpha");
    B = await createTenant("Bravo");
  });

  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  /** Acts as a member of workspace A. */
  const asA = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.memberId, fn);
  const asAOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  describe("reads cannot cross the boundary", () => {
    test("search never returns another workspace's records", async () => {
      const { searchEverything } = await import("../../src/lib/data/search");
      const hits = await searchEverything([A.workspaceId], "Bravo");
      assert.equal(hits.length, 0, "search leaked records from workspace B");
    });

    test("contact list is scoped", async () => {
      const { listContacts } = await import("../../src/lib/data/contacts");
      const { contacts } = await listContacts([A.workspaceId], {});
      assert.ok(
        contacts.every((c) => c.workspaceId === A.workspaceId),
        "contact list leaked another workspace",
      );
      assert.ok(!contacts.some((c) => c.id === B.contactId));
    });

    test("dashboard aggregates only in-scope data", async () => {
      const { getDashboard } = await import("../../src/lib/data/dashboard");
      const dashboard = await getDashboard([A.workspaceId], null);
      const ids = dashboard.recentActivity.map((a) => a.id);
      assert.ok(!ids.includes(B.activityId), "dashboard leaked workspace B activity");
    });

    test("analytics aggregates only in-scope data", async () => {
      const { getAnalytics } = await import("../../src/lib/data/analytics");
      const a = await getAnalytics([A.workspaceId], 365);
      const both = await getAnalytics([A.workspaceId, B.workspaceId], 365);
      // B's deal is worth 5,000.00, so a scoped total must be strictly smaller.
      assert.ok(
        a.pipeline.valueCents < both.pipeline.valueCents,
        "analytics did not scope pipeline value",
      );
    });

    test("AI context is built only from permitted workspaces", async () => {
      const { buildWorkspaceSnapshot } = await import("../../src/lib/ai/context");
      const snapshot = await buildWorkspaceSnapshot({
        workspaceIds: [A.workspaceId],
        workspaceNames: new Map([[A.workspaceId, "Alpha"]]),
      });
      assert.ok(!snapshot.text.includes("Bravo"), "AI context leaked workspace B");
      assert.ok(
        !snapshot.citations.some((c) => c.id === B.dealId),
        "AI context cited a workspace B record",
      );
    });

    test("record fetch for another workspace's record returns nothing", async () => {
      const { getContact } = await import("../../src/lib/data/contacts");
      const contact = await getContact([A.workspaceId], B.contactId);
      assert.equal(contact, null, "fetched a contact from another workspace");
    });

    test("audit log read is scoped", async () => {
      const { listAuditLog } = await import("../../src/lib/audit");
      const { entries } = await listAuditLog([A.workspaceId]);
      assert.ok(
        entries.every((e) => !e.workspace || e.workspace.id === A.workspaceId),
        "audit log leaked another workspace",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Writes — the class of bug the audit found
  // -------------------------------------------------------------------------

  describe("writes reject foreign relation ids", () => {
    test("cannot create a task linked to another workspace's contact", async () => {
      const { createTask } = await import("../../src/lib/actions/tasks");
      const result = await asA(() =>
        createTask({ workspaceId: A.workspaceId, title: "probe", contactId: B.contactId }),
      );
      assert.equal(result.ok, false, "task accepted a foreign contactId");
    });

    test("cannot create a task linked to another workspace's deal", async () => {
      const { createTask } = await import("../../src/lib/actions/tasks");
      const result = await asA(() =>
        createTask({ workspaceId: A.workspaceId, title: "probe", dealId: B.dealId }),
      );
      assert.equal(result.ok, false, "task accepted a foreign dealId");
    });

    test("cannot create a contact attached to another workspace's company", async () => {
      const { createContact } = await import("../../src/lib/actions/contacts");
      const result = await asA(() =>
        createContact({ workspaceId: A.workspaceId, firstName: "Probe", companyId: B.companyId }),
      );
      assert.equal(result.ok, false, "contact accepted a foreign companyId");
    });

    test("cannot create a deal on another workspace's pipeline stage", async () => {
      const { createDeal } = await import("../../src/lib/actions/deals");
      const result = await asA(() =>
        createDeal({
          workspaceId: A.workspaceId,
          name: "probe",
          pipelineId: B.pipelineId,
          stageId: B.stageId,
        }),
      );
      assert.equal(result.ok, false, "deal accepted a foreign pipeline");
    });

    test("cannot move own deal onto another workspace's stage", async () => {
      // This is the exact prototype bug: stageId was written unvalidated, and the
      // deal page then rendered the other tenant's stage name and colour.
      const { moveDealToStage } = await import("../../src/lib/actions/deals");
      const result = await asA(() => moveDealToStage(A.dealId, B.stageId));
      assert.equal(result.ok, false, "deal was moved onto a foreign stage");

      const deal = await db.deal.findUnique({
        where: { id: A.dealId },
        select: { stageId: true },
      });
      assert.equal(deal?.stageId, A.stageId, "deal stage was mutated despite refusal");
    });

    test("cannot create a project with another workspace's status", async () => {
      const { createProject } = await import("../../src/lib/actions/projects");
      const result = await asA(() =>
        createProject({ workspaceId: A.workspaceId, name: "probe", statusId: B.statusId }),
      );
      assert.equal(result.ok, false, "project accepted a foreign statusId");
    });

    test("cannot create a note linked to another workspace's project", async () => {
      const { createNote } = await import("../../src/lib/actions/notes");
      const result = await asA(() =>
        createNote({ workspaceId: A.workspaceId, body: "<p>probe</p>", projectId: B.projectId }),
      );
      assert.equal(result.ok, false, "note accepted a foreign projectId");
    });

    test("cannot log an activity against another workspace's company", async () => {
      const { logTimelineEntry } = await import("../../src/lib/actions/activities");
      const result = await asA(() =>
        logTimelineEntry({
          workspaceId: A.workspaceId,
          type: "call",
          title: "probe",
          companyId: B.companyId,
        }),
      );
      assert.equal(result.ok, false, "activity accepted a foreign companyId");
    });
  });

  describe("writes reject foreign target records", () => {
    test("cannot update another workspace's contact", async () => {
      const { updateContact } = await import("../../src/lib/actions/contacts");
      const result = await asA(() => updateContact(B.contactId, { firstName: "Pwned" }));
      assert.equal(result.ok, false, "updated a contact in another workspace");

      const contact = await db.contact.findUnique({
        where: { id: B.contactId },
        select: { firstName: true },
      });
      assert.equal(contact?.firstName, "Bravo", "contact was mutated despite refusal");
    });

    test("cannot archive another workspace's deal", async () => {
      const { archiveDeal } = await import("../../src/lib/actions/deals");
      const result = await asA(() => archiveDeal(B.dealId));
      assert.equal(result.ok, false, "archived a deal in another workspace");

      const deal = await db.deal.findUnique({ where: { id: B.dealId }, select: { archivedAt: true } });
      assert.equal(deal?.archivedAt, null, "deal was archived despite refusal");
    });

    test("cannot delete another workspace's project", async () => {
      const { deleteProject } = await import("../../src/lib/actions/projects");
      const result = await asAOwner(() => deleteProject(B.projectId, "Bravo Secret Project"));
      assert.equal(result.ok, false, "deleted a project in another workspace");

      const project = await db.project.findUnique({ where: { id: B.projectId } });
      assert.ok(project, "project was deleted despite refusal");
    });

    test("cannot toggle another workspace's task", async () => {
      const { toggleTask } = await import("../../src/lib/actions/tasks");
      const result = await asA(() => toggleTask(B.taskId));
      assert.equal(result.ok, false, "toggled a task in another workspace");
    });

    test("cannot delete another workspace's note", async () => {
      const { deleteNote } = await import("../../src/lib/actions/notes");
      const result = await asAOwner(() => deleteNote(B.noteId, "Bravo private note"));
      assert.equal(result.ok, false, "deleted a note in another workspace");
    });

    test("cannot disable another workspace's automation", async () => {
      const { setAutomationEnabled } = await import("../../src/lib/actions/automations");
      const result = await asAOwner(() => setAutomationEnabled(B.automationId, false));
      assert.equal(result.ok, false, "modified an automation in another workspace");
    });

    test("cannot delete another workspace's tag", async () => {
      const { deleteTag } = await import("../../src/lib/actions/settings");
      const result = await asAOwner(() => deleteTag(B.tagId));
      assert.equal(result.ok, false, "deleted a tag in another workspace");
    });

    test("cannot rename another workspace", async () => {
      const { updateWorkspace } = await import("../../src/lib/actions/settings");
      const result = await asAOwner(() => updateWorkspace(B.workspaceId, { name: "Pwned" }));
      assert.equal(result.ok, false, "renamed another workspace");
    });

    test("cannot delete another workspace", async () => {
      const { deleteWorkspace } = await import("../../src/lib/actions/settings");
      const result = await asAOwner(() => deleteWorkspace(B.workspaceId, "Bravo Workspace"));
      assert.equal(result.ok, false, "deleted another workspace");

      const workspace = await db.workspace.findUnique({ where: { id: B.workspaceId } });
      assert.ok(workspace, "workspace was deleted despite refusal");
    });

    test("cannot change a role in another workspace", async () => {
      const { changeMemberRole } = await import("../../src/lib/actions/settings");
      const result = await asAOwner(() =>
        changeMemberRole({ workspaceId: B.workspaceId, userId: B.memberId, role: "owner" }),
      );
      assert.equal(result.ok, false, "changed a role in another workspace");
    });
  });

  describe("AI cannot be steered across the boundary", () => {
    test("cannot summarise another workspace's record", async () => {
      const { refreshRecordSummary } = await import("../../src/lib/actions/ai");
      const result = await asA(() => refreshRecordSummary("deal", B.dealId));
      assert.equal(result.ok, false, "AI summarised a record in another workspace");
    });

    test("AI proposals cannot link to a foreign record", async () => {
      const { applyProposals } = await import("../../src/lib/actions/ai");
      const result = await asA(() =>
        applyProposals(
          A.workspaceId,
          [
            {
              id: "p0",
              kind: "contact",
              label: "Link to a foreign contact",
              matchId: B.contactId,
              isNew: false,
              payload: {},
            },
          ],
          "probe",
        ),
      );
      assert.equal(result.ok, false, "AI proposal linked a record from another workspace");
    });

    test("cleanup suggestion cannot rewrite a foreign contact", async () => {
      // The prototype's applyRecommendation had no ownership check at all, so
      // this rewrote any contact in the database (F-02).
      const { applyRecommendation } = await import("../../src/lib/actions/ai");
      const result = await asA(() =>
        applyRecommendation(
          "link_company",
          { contactId: B.contactId, companyId: A.companyId },
          A.workspaceId,
        ),
      );
      assert.equal(result.ok, false, "cleanup rewrote a contact in another workspace");

      const contact = await db.contact.findUnique({
        where: { id: B.contactId },
        select: { companyId: true },
      });
      assert.equal(contact?.companyId, B.companyId, "foreign contact was mutated");
    });

    test("cannot dismiss an insight in another workspace", async () => {
      const insight = await db.aiInsight.create({
        data: {
          workspaceId: B.workspaceId, kind: "summary", entityType: "deal",
          entityId: B.dealId, title: "t", body: "b",
        },
      });
      const { dismissInsight } = await import("../../src/lib/actions/ai");
      const result = await asA(() => dismissInsight(insight.id));
      assert.equal(result.ok, false, "dismissed an insight in another workspace");
    });
  });

  describe("bulk operations and exports are scoped", () => {
    test("bulk complete ignores ids from another workspace", async () => {
      const { bulkCompleteTasks } = await import("../../src/lib/actions/tasks");
      const result = await asA(() => bulkCompleteTasks(A.workspaceId, [A.taskId, B.taskId]));
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.updated, 1, "bulk update touched a foreign task");
      }
      const foreign = await db.task.findUnique({ where: { id: B.taskId }, select: { status: true } });
      assert.notEqual(foreign?.status, "done", "foreign task was completed");
    });

    test("bulk operation targeting another workspace is refused outright", async () => {
      const { bulkCompleteTasks } = await import("../../src/lib/actions/tasks");
      const result = await asA(() => bulkCompleteTasks(B.workspaceId, [B.taskId]));
      assert.equal(result.ok, false, "bulk operation ran against another workspace");
    });

    test("export contains no records from another workspace", async () => {
      const { exportCsv } = await import("../../src/lib/actions/import-export");
      const result = await asAOwner(() => exportCsv("contacts", A.workspaceId));
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(!result.data.csv.includes("Bravo"), "export leaked workspace B contacts");
        assert.ok(result.data.csv.includes("Alpha"), "export omitted the caller's own contacts");
      }
    });

    test("import cannot write into another workspace", async () => {
      const { runImport } = await import("../../src/lib/actions/import-export");
      const result = await asAOwner(() =>
        runImport("contacts", B.workspaceId, "First Name,Email\nMallory,m@x.test"),
      );
      assert.equal(result.ok, false, "import wrote into another workspace");
    });
  });
});
