import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Engine-behaviour regression tests.
 *
 * These run against whichever database `DATABASE_URL` names, and assert the
 * behaviours the application *relies on* rather than the ones the engines
 * happen to share. Each case here corresponds to a difference that was found by
 * running `scripts/db-differences.ts` against a real PostgreSQL 17 server —
 * including two that a green test suite on both engines did not reveal.
 *
 * Run on both:
 *   npm test                     # SQLite
 *   npm run test:pg              # PostgreSQL
 */

const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");

let A: Tenant;

describe(`engine behaviour (${isPostgres ? "PostgreSQL" : "SQLite"})`, () => {
  before(async () => {
    A = await createTenant("Engine");
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  describe("case sensitivity", () => {
    test("application search is case-insensitive on both engines", async () => {
      // The difference this covers: Prisma compiles `contains` to LIKE, which
      // is case-insensitive on SQLite and case-sensitive on PostgreSQL. Without
      // the `contains()` helper, search verified in development would silently
      // start missing results in production.
      const { searchEverything } = await import("../../src/lib/data/search");

      const lower = await searchEverything([A.workspaceId], "engine");
      const upper = await searchEverything([A.workspaceId], "ENGINE");
      const mixed = await searchEverything([A.workspaceId], "EnGiNe");

      assert.ok(lower.length > 0, "search found nothing to compare");
      assert.equal(upper.length, lower.length, "uppercase search returned a different count");
      assert.equal(mixed.length, lower.length, "mixed-case search returned a different count");
    });

    test("list filters are case-insensitive on both engines", async () => {
      const { listContacts } = await import("../../src/lib/data/contacts");
      const lower = await listContacts([A.workspaceId], { q: "confidential" });
      const upper = await listContacts([A.workspaceId], { q: "CONFIDENTIAL" });
      assert.ok(lower.contacts.length > 0);
      assert.equal(upper.contacts.length, lower.contacts.length);
    });

    test("equality remains case-sensitive, on purpose", async () => {
      // Only substring search is case-folded. An exact match on an email or a
      // slug must stay exact, or two distinct records could collide.
      const exact = await db.contact.count({
        where: { workspaceId: A.workspaceId, fullName: "Engine Confidential" },
      });
      const wrongCase = await db.contact.count({
        where: { workspaceId: A.workspaceId, fullName: "ENGINE CONFIDENTIAL" },
      });
      assert.equal(exact, 1);
      assert.equal(wrongCase, 0, "equality became case-insensitive");
    });
  });

  describe("LIKE metacharacters", () => {
    test("a wildcard-only search matches nothing rather than everything", async () => {
      // Prisma does not escape `%` or `_`, so `?q=%` compiles to LIKE '%%%'
      // and matches every row — the cheapest way for a signed-in user to force
      // the most expensive query in the product.
      const { searchEverything } = await import("../../src/lib/data/search");
      for (const term of ["%", "_", "%%", "__", "% _ %"]) {
        const hits = await searchEverything([A.workspaceId], term);
        assert.equal(hits.length, 0, `a wildcard-only search ran: ${JSON.stringify(term)}`);
      }
    });

    test("wildcard-only list filters are ignored, not applied", async () => {
      const { listContacts } = await import("../../src/lib/data/contacts");
      const all = await listContacts([A.workspaceId], {});
      const wildcarded = await listContacts([A.workspaceId], { q: "%" });
      assert.equal(
        wildcarded.contacts.length,
        all.contacts.length,
        "a wildcard filter behaved as a filter instead of as no filter",
      );
    });

    test("an underscore in a search term is literal on PostgreSQL", async (t) => {
      // PostgreSQL honours a backslash LIKE escape by default, so the term can
      // be escaped and matched literally. SQLite has no default escape
      // character — the same escaped term matches nothing — so the wildcard
      // behaviour remains in development only. Production is PostgreSQL.
      if (!isPostgres) {
        t.skip("SQLite has no default LIKE escape character; documented in docs/POSTGRES-VERIFICATION.md");
        return;
      }

      const suffix = `eng-${Date.now()}`;
      await db.contact.createMany({
        data: [
          {
            workspaceId: A.workspaceId, firstName: "RFP_2026_014", lastName: suffix,
            fullName: `RFP_2026_014 ${suffix}`,
          },
          {
            workspaceId: A.workspaceId, firstName: "RFPX2026Y014", lastName: suffix,
            fullName: `RFPX2026Y014 ${suffix}`,
          },
        ],
      });

      const { listContacts } = await import("../../src/lib/data/contacts");
      const hits = await listContacts([A.workspaceId], { q: "RFP_2026" });
      const names = hits.contacts.map((c) => c.fullName);

      assert.ok(
        names.some((n) => n.startsWith("RFP_2026_014")),
        "the literal match was lost",
      );
      assert.ok(
        !names.some((n) => n.startsWith("RFPX2026Y014")),
        "an underscore still behaved as a single-character wildcard",
      );

      await db.contact.deleteMany({ where: { workspaceId: A.workspaceId, lastName: suffix } });
    });
  });

  describe("transactions", () => {
    test("a failure rolls back every statement", async () => {
      const before = await db.contact.count({ where: { workspaceId: A.workspaceId } });
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.contact.create({
            data: {
              workspaceId: A.workspaceId, firstName: "Rollback", lastName: "probe",
              fullName: "Rollback probe",
            },
          });
          throw new Error("deliberate");
        }),
      );
      assert.equal(
        await db.contact.count({ where: { workspaceId: A.workspaceId } }),
        before,
        "a rolled-back transaction left a row behind",
      );
    });

    test("a constraint violation aborts the whole transaction", async () => {
      const name = `dup-${Date.now()}`;
      await db.tag.create({ data: { workspaceId: A.workspaceId, name } });
      const before = await db.tag.count({ where: { workspaceId: A.workspaceId } });

      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.tag.create({ data: { workspaceId: A.workspaceId, name: `${name}-ok` } });
          await tx.tag.create({ data: { workspaceId: A.workspaceId, name } }); // duplicate
        }),
      );

      assert.equal(
        await db.tag.count({ where: { workspaceId: A.workspaceId } }),
        before,
        "the successful half of an aborted transaction was committed",
      );
    });
  });

  describe("concurrency", () => {
    test("exactly one of two racing version-guarded writes lands", async () => {
      const contact = await db.contact.findUniqueOrThrow({ where: { id: A.contactId } });
      const version = contact.version;

      const [first, second] = await Promise.all([
        db.contact.updateMany({
          where: { id: A.contactId, workspaceId: A.workspaceId, version },
          data: { jobTitle: "writer one", version: { increment: 1 } },
        }),
        db.contact.updateMany({
          where: { id: A.contactId, workspaceId: A.workspaceId, version },
          data: { jobTitle: "writer two", version: { increment: 1 } },
        }),
      ]);

      assert.equal(
        first.count + second.count,
        1,
        "both racing writes landed — optimistic concurrency does not hold on this engine",
      );
    });

    test("concurrent atomic increments do not lose updates", async () => {
      const before = await db.deal.findUniqueOrThrow({ where: { id: A.dealId } });
      await Promise.all(
        Array.from({ length: 25 }, () =>
          db.deal.updateMany({ where: { id: A.dealId }, data: { valueCents: { increment: 1 } } }),
        ),
      );
      const after = await db.deal.findUniqueOrThrow({ where: { id: A.dealId } });
      assert.equal(after.valueCents - before.valueCents, 25, "an increment was lost");
    });
  });

  describe("constraints", () => {
    test("compound uniqueness is per workspace, not global", async () => {
      const B = await createTenant("EngineOther");
      try {
        const name = `shared-${Date.now()}`;
        await db.tag.create({ data: { workspaceId: A.workspaceId, name } });
        await assert.doesNotReject(
          db.tag.create({ data: { workspaceId: B.workspaceId, name } }),
          "the same tag name was rejected in a different workspace",
        );
        await assert.rejects(
          db.tag.create({ data: { workspaceId: A.workspaceId, name } }),
          "a duplicate within one workspace was accepted",
        );
      } finally {
        await cleanupTenants([B]);
      }
    });

    test("a dangling foreign key is rejected", async () => {
      await assert.rejects(
        db.contact.create({
          data: {
            workspaceId: A.workspaceId, firstName: "Dangle", lastName: "x",
            fullName: "Dangle x", companyId: "no-such-company-id",
          },
        }),
        "foreign keys are not enforced on this engine",
      );
    });

    test("deleting a parent detaches children rather than destroying them", async () => {
      const company = await db.company.create({
        data: { workspaceId: A.workspaceId, name: `Detach ${Date.now()}` },
      });
      const activity = await db.activity.create({
        data: {
          workspaceId: A.workspaceId, type: "call", title: "history",
          companyId: company.id, actorId: A.ownerId,
        },
      });

      await db.company.delete({ where: { id: company.id } });

      const survivor = await db.activity.findUnique({ where: { id: activity.id } });
      assert.ok(survivor, "the cascade destroyed history");
      assert.equal(survivor!.companyId, null, "the child was not detached");
    });

    test("deleting a workspace cascades everything below it", async () => {
      const B = await createTenant("EngineCascade");
      await db.workspace.delete({ where: { id: B.workspaceId } });
      for (const [label, count] of [
        ["contacts", await db.contact.count({ where: { workspaceId: B.workspaceId } })],
        ["deals", await db.deal.count({ where: { workspaceId: B.workspaceId } })],
        ["activities", await db.activity.count({ where: { workspaceId: B.workspaceId } })],
      ] as const) {
        assert.equal(count, 0, `${label} survived the workspace cascade`);
      }
      await db.user.deleteMany({ where: { id: { in: [B.ownerId, B.memberId, B.viewerId] } } });
    });
  });

  describe("dates", () => {
    test("an instant round-trips with millisecond precision", async () => {
      const instant = new Date("2026-03-08T09:30:45.123Z");
      const task = await db.task.create({
        data: { workspaceId: A.workspaceId, title: "Date probe", dueAt: instant },
      });
      const read = await db.task.findUniqueOrThrow({ where: { id: task.id } });

      assert.ok(read.dueAt instanceof Date, "a timestamp came back as something other than a Date");
      assert.equal(read.dueAt!.toISOString(), instant.toISOString(), "the instant shifted");
      assert.equal(read.dueAt!.getUTCMilliseconds(), 123, "milliseconds were truncated");
    });

    test("range comparisons use the stored instant, not a string", async () => {
      const suffix = `date-${Date.now()}`;
      await db.task.createMany({
        data: [
          { workspaceId: A.workspaceId, title: `${suffix} early`, dueAt: new Date("2020-01-01T00:00:00Z") },
          { workspaceId: A.workspaceId, title: `${suffix} late`, dueAt: new Date("2030-01-01T00:00:00Z") },
        ],
      });
      const later = await db.task.count({
        where: {
          workspaceId: A.workspaceId,
          title: { startsWith: suffix },
          dueAt: { gt: new Date("2025-01-01T00:00:00Z") },
        },
      });
      assert.equal(later, 1, "a date range comparison did not behave as an instant comparison");
    });
  });
});
