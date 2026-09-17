import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { db as app } from "../../src/lib/db";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Recording what happened to a proposal.
 *
 * The write path behind the RFP lifecycle: marking something submitted, moving
 * it through the buyer's process, and recording how it ended. Three properties
 * matter more than the rest, and each is paired with its opposite so a broken
 * implementation cannot pass by doing nothing:
 *
 *   - the stage follows the lifecycle **only when the workspace has a stage by
 *     that name**, and a missing one is left alone rather than invented;
 *   - the historical deadline is never rewritten;
 *   - every transition is a person's decision — nothing here infers a state.
 */

let A: Tenant;

/** Runs a write as the workspace, on both engines, the way the app does. */
function asWorkspace<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
  return withTenantContext({ workspaceIds: [tenant.workspaceId], userId: tenant.ownerId }, fn);
}

/** An opportunity pipeline with the stages named in `stages`. */
async function pipelineWith(tenant: Tenant, name: string, stages: string[]) {
  return asWorkspace(tenant, async () => {
    const pipeline = await app.pipeline.create({
      data: {
        workspaceId: tenant.workspaceId,
        name,
        kind: "opportunity",
        stages: {
          create: stages.map((stageName, order) => ({
            name: stageName,
            order,
            kind: stageName === "Awarded" ? "won" : stageName === "Not Awarded" ? "lost" : "open",
          })),
        },
      },
      include: { stages: { orderBy: { order: "asc" } } },
    });
    return pipeline;
  });
}

/** A fresh opportunity, optionally in a pipeline, with a deadline in the past. */
async function opportunity(
  tenant: Tenant,
  label: string,
  options: { pipelineId?: string; stageId?: string } = {},
) {
  return asWorkspace(tenant, async () =>
    app.opportunity.create({
      data: {
        workspaceId: tenant.workspaceId,
        name: `${label} ${Date.now()}`,
        proposalDeadlineAt: new Date(Date.now() - 2 * 86_400_000),
        deadlineAt: new Date(Date.now() - 2 * 86_400_000),
        ...(options.pipelineId ? { pipelineId: options.pipelineId } : {}),
        ...(options.stageId ? { stageId: options.stageId } : {}),
      },
      select: { id: true, version: true, proposalDeadlineAt: true },
    }),
  );
}

/** The opportunity as it now stands, read past RLS with the fixtures' client. */
async function read(id: string) {
  return asWorkspace(A, async () =>
    app.opportunity.findFirstOrThrow({
      where: { id },
      select: {
        submissionStatus: true, submittedAt: true, decisionExpectedAt: true, decidedAt: true,
        proposalDeadlineAt: true, deadlineAt: true, version: true,
        stage: { select: { name: true } },
      },
    }),
  );
}

async function activityTitles(id: string) {
  return asWorkspace(A, async () =>
    (await app.activity.findMany({
      where: { opportunityId: id },
      select: { title: true, type: true },
      orderBy: { occurredAt: "asc" },
    })),
  );
}

describe("recording what happened to a proposal", () => {
  before(async () => {
    A = await createTenant("LifecycleAlpha");
  });
  // Each case performs several writes as one person; without this the mutation
  // limiter, not the lifecycle, would decide what passes.
  beforeEach(async () => {
    await resetRateLimit("mutation", { user: A.ownerId, workspace: A.workspaceId });
    await resetRateLimit("mutation", { user: A.viewerId, workspace: A.workspaceId });
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  describe("marking it submitted", () => {
    test("sets the status and the date, and never touches the deadline", async () => {
      const opp = await opportunity(A, "Submitted case");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");

      const submittedOn = new Date(Date.now() - 86_400_000);
      const result = await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { submittedAt: submittedOn, version: opp.version }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));

      const after = await read(opp.id);
      assert.equal(after.submissionStatus, "submitted");
      assert.ok(after.submittedAt, "no submission date was stored");
      assert.equal(
        after.proposalDeadlineAt?.getTime(),
        opp.proposalDeadlineAt?.getTime(),
        "the historical deadline was rewritten",
      );
      assert.equal(after.version, opp.version + 1, "optimistic concurrency did not advance");
    });

    test("defaults to today when no date is given", async () => {
      const opp = await opportunity(A, "Default date");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      const result = await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));

      const after = await read(opp.id);
      const hoursAgo = (Date.now() - (after.submittedAt?.getTime() ?? 0)) / 3_600_000;
      assert.ok(hoursAgo >= 0 && hoursAgo < 24, `submittedAt was ${hoursAgo}h ago`);
    });

    test("records the expected decision date when one is given", async () => {
      const opp = await opportunity(A, "Expected date");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      const expected = new Date(Date.now() + 21 * 86_400_000);
      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { decisionExpectedAt: expected, version: opp.version }),
      );
      const after = await read(opp.id);
      assert.ok(after.decisionExpectedAt, "the expected decision date was dropped");
    });

    test("writes a timeline entry and a lifecycle event", async () => {
      const opp = await opportunity(A, "Timeline");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );

      const titles = (await activityTitles(opp.id)).map((a) => a.title);
      assert.ok(titles.includes("Submitted the proposal"), `timeline says: ${titles.join(", ")}`);

      const events = await asWorkspace(A, async () =>
        app.domainEvent.findMany({ where: { entityId: opp.id }, select: { name: true } }),
      );
      assert.ok(
        events.some((e) => e.name === "opportunity.submitted"),
        `events: ${events.map((e) => e.name).join(", ") || "none"}`,
      );
    });

    test("a stale version is refused", async () => {
      const opp = await opportunity(A, "Concurrency");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      const second = await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      assert.equal(second.ok, false, "a stale write was accepted");
    });

    test("a role without record:edit is refused", async () => {
      const opp = await opportunity(A, "Viewer");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      const result = await runAsTestIdentity(A.viewerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      assert.equal(result.ok, false, "a viewer marked an opportunity submitted");
      const after = await read(opp.id);
      assert.equal(after.submissionStatus, "not_started");
    });
  });

  describe("the guarded pipeline move", () => {
    test("moves to a Submitted stage when the workspace has one", async () => {
      const pipeline = await pipelineWith(A, `Full ${Date.now()}`, ["Drafting", "Submitted", "Awarded", "Not Awarded"]);
      const opp = await opportunity(A, "With stages", {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0]!.id,
      });
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );

      const after = await read(opp.id);
      assert.equal(after.stage?.name, "Submitted");
      const titles = (await activityTitles(opp.id)).map((a) => a.title);
      assert.ok(titles.includes("Moved to Submitted"), `timeline says: ${titles.join(", ")}`);
    });

    test("leaves the stage alone when no stage has that name, and creates nothing", async () => {
      const pipeline = await pipelineWith(A, `Sparse ${Date.now()}`, ["Drafting", "Review"]);
      const opp = await opportunity(A, "No submitted stage", {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0]!.id,
      });
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      const result = await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));

      const after = await read(opp.id);
      assert.equal(after.submissionStatus, "submitted", "the lifecycle did not advance");
      assert.equal(after.stage?.name, "Drafting", "the stage moved without a matching stage");

      const stages = await asWorkspace(A, async () =>
        app.pipelineStage.findMany({ where: { pipelineId: pipeline.id }, select: { name: true } }),
      );
      assert.equal(stages.length, 2, "a stage was created");
    });

    test("an opportunity with no pipeline at all still submits", async () => {
      const opp = await opportunity(A, "No pipeline");
      const { markOpportunitySubmitted } = await import("../../src/lib/actions/opportunities");
      const result = await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await read(opp.id)).submissionStatus, "submitted");
    });
  });

  describe("the buyer's process, and only by hand", () => {
    test("under review and shortlisted are set by a person, and move no stage", async () => {
      const pipeline = await pipelineWith(A, `Manual ${Date.now()}`, ["Drafting", "Submitted", "Awarded", "Not Awarded"]);
      const opp = await opportunity(A, "Manual states", {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0]!.id,
      });
      const { markOpportunitySubmitted, setOpportunityLifecycleState } =
        await import("../../src/lib/actions/opportunities");

      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      const submitted = await read(opp.id);

      const review = await runAsTestIdentity(A.ownerId, () =>
        setOpportunityLifecycleState(opp.id, { status: "under_review", version: submitted.version }),
      );
      assert.equal(review.ok, true, JSON.stringify(review));
      const reviewing = await read(opp.id);
      assert.equal(reviewing.submissionStatus, "under_review");
      assert.equal(reviewing.stage?.name, "Submitted", "a manual state moved the pipeline");

      const short = await runAsTestIdentity(A.ownerId, () =>
        setOpportunityLifecycleState(opp.id, { status: "shortlisted", version: reviewing.version }),
      );
      assert.equal(short.ok, true, JSON.stringify(short));
      assert.equal((await read(opp.id)).submissionStatus, "shortlisted");
    });
  });

  describe("how it ended", () => {
    test("awarded records the date and moves to the Awarded stage", async () => {
      const pipeline = await pipelineWith(A, `Won ${Date.now()}`, ["Drafting", "Submitted", "Awarded", "Not Awarded"]);
      const opp = await opportunity(A, "Awarded", {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[1]!.id,
      });
      const { recordOpportunityOutcome } = await import("../../src/lib/actions/opportunities");
      const result = await runAsTestIdentity(A.ownerId, () =>
        recordOpportunityOutcome(opp.id, { outcome: "won", version: opp.version }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));

      const after = await read(opp.id);
      assert.equal(after.submissionStatus, "won");
      assert.ok(after.decidedAt, "no decision date was stored");
      assert.equal(after.stage?.name, "Awarded");
    });

    test("not awarded moves to Not Awarded", async () => {
      const pipeline = await pipelineWith(A, `Lost ${Date.now()}`, ["Drafting", "Submitted", "Awarded", "Not Awarded"]);
      const opp = await opportunity(A, "Not awarded", {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[1]!.id,
      });
      const { recordOpportunityOutcome } = await import("../../src/lib/actions/opportunities");
      await runAsTestIdentity(A.ownerId, () =>
        recordOpportunityOutcome(opp.id, { outcome: "lost", version: opp.version }),
      );
      assert.equal((await read(opp.id)).stage?.name, "Not Awarded");
    });

    test("withdrawn is an ending in its own right, and needs no submission", async () => {
      // No workspace here has a "Withdrawn" stage, which is the point: the
      // lifecycle still records it, and the pipeline is left where it was.
      const pipeline = await pipelineWith(A, `Withdrawn ${Date.now()}`, ["Drafting", "Submitted", "Awarded", "Not Awarded"]);
      const opp = await opportunity(A, "Withdrawn", {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0]!.id,
      });
      const { recordOpportunityOutcome } = await import("../../src/lib/actions/opportunities");
      const result = await runAsTestIdentity(A.ownerId, () =>
        recordOpportunityOutcome(opp.id, { outcome: "withdrawn", version: opp.version }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));

      const after = await read(opp.id);
      assert.equal(after.submissionStatus, "withdrawn");
      assert.ok(after.decidedAt, "no decision date was stored");
      assert.equal(after.stage?.name, "Drafting", "withdrawal moved the pipeline");
      assert.equal(after.submittedAt, null, "withdrawal invented a submission");
    });

    test("an outcome emits its event", async () => {
      const opp = await opportunity(A, "Outcome event");
      const { recordOpportunityOutcome } = await import("../../src/lib/actions/opportunities");
      await runAsTestIdentity(A.ownerId, () =>
        recordOpportunityOutcome(opp.id, { outcome: "won", version: opp.version }),
      );
      const events = await asWorkspace(A, async () =>
        app.domainEvent.findMany({ where: { entityId: opp.id }, select: { name: true } }),
      );
      assert.ok(
        events.some((e) => e.name === "opportunity.decided"),
        `events: ${events.map((e) => e.name).join(", ") || "none"}`,
      );
    });
  });

  describe("when we expect to hear back", () => {
    // "Unknown" is a state the record holds, not the absence of one, so the
    // interesting direction is the one that removes a date: an implementation
    // that treats null as "leave it alone" passes every test that only ever
    // sets a date, and then silently refuses to forget one.
    test("a date can be set after submission, and then taken away again", async () => {
      const opp = await opportunity(A, "Expected round trip");
      const { markOpportunitySubmitted, setOpportunityDecisionExpected } = await import(
        "../../src/lib/actions/opportunities"
      );

      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      const submitted = await read(opp.id);
      assert.equal(submitted.decisionExpectedAt, null, "submission invented an expected date");

      await runAsTestIdentity(A.ownerId, () =>
        setOpportunityDecisionExpected(opp.id, {
          decisionExpectedAt: "2026-11-20",
          version: submitted.version,
        }),
      );
      const known = await read(opp.id);
      assert.ok(known.decisionExpectedAt, "the expected date was not stored");
      assert.equal(known.decisionExpectedAt?.toISOString().slice(0, 10), "2026-11-20");

      await runAsTestIdentity(A.ownerId, () =>
        setOpportunityDecisionExpected(opp.id, {
          decisionExpectedAt: null,
          version: known.version,
        }),
      );
      const unknown = await read(opp.id);
      assert.equal(unknown.decisionExpectedAt, null, "a known date could not be made unknown again");

      // The thing being edited is one field: the submission itself is untouched.
      assert.equal(unknown.submissionStatus, "submitted", "the submission status changed");
      assert.ok(unknown.submittedAt, "the submission date was lost");
      assert.deepEqual(
        unknown.proposalDeadlineAt,
        opp.proposalDeadlineAt,
        "the historical deadline was rewritten",
      );
    });

    test("unknown is recorded as a decision, in the record's own history", async () => {
      const opp = await opportunity(A, "Expected history");
      const { markOpportunitySubmitted, setOpportunityDecisionExpected } = await import(
        "../../src/lib/actions/opportunities"
      );
      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { decisionExpectedAt: "2026-12-01", version: opp.version }),
      );
      const before = await read(opp.id);
      await runAsTestIdentity(A.ownerId, () =>
        setOpportunityDecisionExpected(opp.id, { decisionExpectedAt: null, version: before.version }),
      );

      const titles = (await activityTitles(opp.id)).map((a) => a.title);
      assert.ok(
        titles.some((t) => /unknown/i.test(t)),
        `no activity recorded the change: ${titles.join(" | ") || "none"}`,
      );
    });

    test("a stale version is refused, like every other edit", async () => {
      const opp = await opportunity(A, "Expected concurrency");
      const { markOpportunitySubmitted, setOpportunityDecisionExpected } = await import(
        "../../src/lib/actions/opportunities"
      );
      await runAsTestIdentity(A.ownerId, () =>
        markOpportunitySubmitted(opp.id, { version: opp.version }),
      );
      // opp.version is now one behind, because the submission incremented it.
      const result = await runAsTestIdentity(A.ownerId, () =>
        setOpportunityDecisionExpected(opp.id, {
          decisionExpectedAt: "2026-10-05",
          version: opp.version,
        }),
      );
      assert.equal(result.ok, false, "a stale version was accepted");
      const after = await read(opp.id);
      assert.equal(after.decisionExpectedAt, null, "the refused edit was written anyway");
    });
  });
});
