/**
 * Engine behaviour probe.
 *
 * A green test suite on both engines proves the tests pass. It does not prove
 * the engines agree — a test can pass on both while the underlying behaviour
 * differs in a way no assertion happens to touch. This runs the same set of
 * operations against whichever database `DATABASE_URL` names and prints one
 * line per observation, so the two runs can be diffed directly.
 *
 *   DATABASE_URL="file:./diff.db"        npx tsx scripts/db-differences.ts
 *   DATABASE_URL="postgresql://…"        npx tsx scripts/db-differences.ts
 *
 * Every probe here corresponds to something the application actually relies on.
 * A difference that the app does not depend on is noise; a difference it does
 * depend on is a portability bug.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "file:./diff.db";
const isPostgres = /^postgres(ql)?:\/\//.test(url);

const db = new PrismaClient({
  adapter: isPostgres
    ? new PrismaPg({ connectionString: url })
    : new PrismaBetterSqlite3({ url }),
});

const results: { area: string; probe: string; result: string }[] = [];
const record = (area: string, probe: string, result: unknown) =>
  results.push({ area, probe, result: String(result) });

const unique = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function scaffold() {
  const owner = await db.user.create({
    data: { email: `${unique("probe")}@test.local`, name: "Probe Owner" },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "Probe", slug: unique("probe"), ownerId: owner.id,
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  return { userId: owner.id, workspaceId: workspace.id };
}

async function main() {
  console.log(`\nEngine: ${isPostgres ? "PostgreSQL" : "SQLite"}  (${url.replace(/:[^:@/]*@/, ":***@")})`);

  if (isPostgres) {
    const [{ version }] = await db.$queryRawUnsafe<{ version: string }[]>("SELECT version()");
    console.log(version.split(",")[0]);
  }

  const { userId, workspaceId } = await scaffold();

  // -------------------------------------------------------------------------
  // Case sensitivity in equality and ordering
  // -------------------------------------------------------------------------
  await db.contact.createMany({
    data: [
      { workspaceId, firstName: "alpha", lastName: "x", fullName: "alpha probe", ownerId: userId },
      { workspaceId, firstName: "ALPHA", lastName: "x", fullName: "ALPHA probe", ownerId: userId },
      { workspaceId, firstName: "Beta", lastName: "x", fullName: "Beta probe", ownerId: userId },
    ],
  });

  const exact = await db.contact.count({ where: { workspaceId, fullName: "alpha probe" } });
  record("case sensitivity", "equality matches only the exact case", exact === 1);

  const caseInsensitiveEquality = await db.contact.count({
    where: { workspaceId, fullName: "ALPHA PROBE" },
  });
  record("case sensitivity", "equality is case-sensitive", caseInsensitiveEquality === 0);

  const ordered = await db.contact.findMany({
    where: { workspaceId }, orderBy: { fullName: "asc" }, select: { fullName: true },
  });
  record("case sensitivity", "ORDER BY sequence", ordered.map((c) => c.fullName).join(" | "));

  // -------------------------------------------------------------------------
  // LIKE / ILIKE — the difference the app's `contains()` helper exists for
  // -------------------------------------------------------------------------
  const rawContains = await db.contact.count({
    where: { workspaceId, fullName: { contains: "ALPHA" } },
  });
  record("LIKE", "bare `contains` is case-INsensitive", rawContains > 1);

  // The application's own helper, so the probe measures what the app does
  // rather than what a hand-written filter would do. Cast because the generated
  // client's filter type depends on which provider it was generated for, and
  // this script deliberately runs against both.
  const { contains } = await import("../src/lib/db");

  const helperContains = await db.contact.count({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: { workspaceId, fullName: contains("ALPHA") as any },
  });
  record("LIKE", "app helper matches both cases", helperContains === 2);

  await db.contact.create({
    data: { workspaceId, firstName: "50%", lastName: "y", fullName: "50% discount deal", ownerId: userId },
  });
  const wildcard = await db.contact.count({ where: { workspaceId, fullName: { contains: "50%" } } });
  record("LIKE", "a literal % in the search term is escaped", wildcard === 1);

  const underscore = await db.contact.count({ where: { workspaceId, fullName: { contains: "a_pha" } } });
  record("LIKE", "a literal _ does not act as a wildcard", underscore === 0);

  // -------------------------------------------------------------------------
  // Uniqueness
  // -------------------------------------------------------------------------
  const tagName = unique("tag");
  await db.tag.create({ data: { workspaceId, name: tagName } });
  record("uniqueness", "compound unique rejects a duplicate", await rejects(() =>
    db.tag.create({ data: { workspaceId, name: tagName } }),
  ));
  record("uniqueness", "same value in another workspace is allowed", await allows(async () => {
    const other = await scaffold();
    await db.tag.create({ data: { workspaceId: other.workspaceId, name: tagName } });
  }));
  record("uniqueness", "unique index treats case as distinct", await allows(() =>
    db.tag.create({ data: { workspaceId, name: tagName.toUpperCase() } }),
  ));

  // NULLs in a unique column
  const c1 = await db.company.create({ data: { workspaceId, name: "Null probe 1", ownerId: userId } });
  const c2 = await db.company.create({ data: { workspaceId, name: "Null probe 2", ownerId: userId } });
  record("uniqueness", "multiple NULLs allowed in a UNIQUE column", c1.primaryContactId === null && c2.primaryContactId === null);

  // -------------------------------------------------------------------------
  // Foreign keys
  // -------------------------------------------------------------------------
  record("foreign keys", "a dangling FK is rejected", await rejects(() =>
    db.contact.create({
      data: {
        workspaceId, firstName: "Dangle", lastName: "x", fullName: "Dangle x",
        companyId: "does-not-exist-at-all",
      },
    }),
  ));

  // -------------------------------------------------------------------------
  // Cascade vs SetNull
  // -------------------------------------------------------------------------
  const cascadeCompany = await db.company.create({
    data: { workspaceId, name: "Cascade probe", ownerId: userId },
  });
  const attachedActivity = await db.activity.create({
    data: { workspaceId, type: "call", title: "attached", companyId: cascadeCompany.id, actorId: userId },
  });
  await db.company.delete({ where: { id: cascadeCompany.id } });
  const survivor = await db.activity.findUnique({ where: { id: attachedActivity.id } });
  record("cascade", "deleting a company detaches its activity (SetNull)", survivor !== null && survivor.companyId === null);

  const cascadeWs = await scaffold();
  await db.contact.create({
    data: {
      workspaceId: cascadeWs.workspaceId, firstName: "Cascade", lastName: "x",
      fullName: "Cascade x", ownerId: cascadeWs.userId,
    },
  });
  await db.workspace.delete({ where: { id: cascadeWs.workspaceId } });
  const orphans = await db.contact.count({ where: { workspaceId: cascadeWs.workspaceId } });
  record("cascade", "deleting a workspace cascades its contacts", orphans === 0);

  // -------------------------------------------------------------------------
  // Nullable relations
  // -------------------------------------------------------------------------
  const orphanTask = await db.task.create({
    data: { workspaceId, title: "No relations", ownerId: null },
  });
  record("nullable relations", "a record with every optional FK null is valid", orphanTask.ownerId === null);

  // -------------------------------------------------------------------------
  // Dates
  // -------------------------------------------------------------------------
  const preciseDate = new Date("2026-03-08T09:30:45.123Z");
  const dated = await db.task.create({
    data: { workspaceId, title: "Date probe", dueAt: preciseDate },
  });
  const readBack = await db.task.findUniqueOrThrow({ where: { id: dated.id } });
  record("dates", "round-trips to the same instant", readBack.dueAt?.toISOString() === preciseDate.toISOString());
  record("dates", "millisecond precision preserved", readBack.dueAt?.getUTCMilliseconds() === 123);
  record("dates", "read back as a Date object", readBack.dueAt instanceof Date);

  const future = await db.task.count({
    where: { workspaceId, dueAt: { gt: new Date("2026-01-01T00:00:00Z") } },
  });
  record("dates", "range comparison works", future >= 1);

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------
  const before = await db.contact.count({ where: { workspaceId } });
  try {
    await db.$transaction(async (tx) => {
      await tx.contact.create({
        data: { workspaceId, firstName: "Rollback", lastName: "x", fullName: "Rollback x" },
      });
      throw new Error("deliberate");
    });
  } catch {
    /* expected */
  }
  const after = await db.contact.count({ where: { workspaceId } });
  record("transactions", "a thrown error rolls the whole transaction back", after === before);

  record("transactions", "a constraint violation inside a transaction aborts it", await rejects(() =>
    db.$transaction(async (tx) => {
      await tx.tag.create({ data: { workspaceId, name: unique("tx") } });
      await tx.tag.create({ data: { workspaceId, name: tagName } }); // duplicate
    }),
  ));

  // -------------------------------------------------------------------------
  // Concurrent updates — the optimistic-concurrency guard the app relies on
  // -------------------------------------------------------------------------
  const contended = await db.contact.create({
    data: { workspaceId, firstName: "Contended", lastName: "x", fullName: "Contended x" },
  });
  const version = contended.version;

  const [first, second] = await Promise.all([
    db.contact.updateMany({
      where: { id: contended.id, workspaceId, version },
      data: { jobTitle: "writer one", version: { increment: 1 } },
    }),
    db.contact.updateMany({
      where: { id: contended.id, workspaceId, version },
      data: { jobTitle: "writer two", version: { increment: 1 } },
    }),
  ]);
  record("concurrency", "exactly one of two racing version-guarded writes lands", first.count + second.count === 1);

  const counterTarget = await db.deal.findFirst({ where: { workspaceId } });
  if (!counterTarget) {
    const pipeline = await db.pipeline.create({
      data: {
        workspaceId, name: "Probe", kind: "deal",
        stages: { create: [{ name: "One", order: 0 }] },
      },
      include: { stages: true },
    });
    await db.deal.create({
      data: {
        workspaceId, name: "Counter probe", pipelineId: pipeline.id,
        stageId: pipeline.stages[0]!.id, valueCents: 0,
      },
    });
  }
  const deal = await db.deal.findFirstOrThrow({ where: { workspaceId } });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      db.deal.updateMany({ where: { id: deal.id }, data: { valueCents: { increment: 1 } } }),
    ),
  );
  const incremented = await db.deal.findUniqueOrThrow({ where: { id: deal.id } });
  record("concurrency", "20 concurrent atomic increments all land", incremented.valueCents - deal.valueCents === 20);

  // -------------------------------------------------------------------------
  // Compound indexes — that the planner will actually use them
  // -------------------------------------------------------------------------
  if (isPostgres) {
    const plan = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN SELECT * FROM "Contact" WHERE "workspaceId" = $1 AND "archivedAt" IS NULL ORDER BY "lastContactedAt" DESC LIMIT 50`,
      workspaceId,
    );
    const text = plan.map((r) => r["QUERY PLAN"]).join(" ");
    record("compound indexes", "planner output for the contact list", text.replace(/\s+/g, " ").slice(0, 110));
  } else {
    const plan = await db.$queryRawUnsafe<{ detail: string }[]>(
      `EXPLAIN QUERY PLAN SELECT * FROM "Contact" WHERE "workspaceId" = ? AND "archivedAt" IS NULL ORDER BY "lastContactedAt" DESC LIMIT 50`,
      workspaceId,
    );
    record("compound indexes", "planner output for the contact list", plan.map((r) => r.detail).join(" ").slice(0, 110));
  }

  // -------------------------------------------------------------------------
  // Search — through the application's own path, not raw SQL
  // -------------------------------------------------------------------------
  const { searchEverything } = await import("../src/lib/data/search");
  const lower = await searchEverything([workspaceId], "alpha");
  const upper = await searchEverything([workspaceId], "ALPHA");
  record("search", "app search is case-insensitive", lower.length > 0 && lower.length === upper.length);
  record("search", "app search hit count for 'alpha'", lower.length);

  const { listContacts } = await import("../src/lib/data/contacts");
  const listed = await listContacts([workspaceId], { q: "beta" });
  record("search", "list filter is case-insensitive", listed.contacts.length === 1);

  // -------------------------------------------------------------------------
  // Aggregates and grouping
  // -------------------------------------------------------------------------
  const grouped = await db.contact.groupBy({
    by: ["workspaceId"],
    where: { workspaceId },
    _count: { _all: true },
  });
  record("aggregates", "groupBy returns a numeric count", typeof grouped[0]?._count._all === "number");

  const sum = await db.deal.aggregate({ where: { workspaceId }, _sum: { valueCents: true } });
  record("aggregates", "SUM of an empty/whole set is a number or null", sum._sum.valueCents === null || typeof sum._sum.valueCents === "number");

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log();
  const width = Math.max(...results.map((r) => r.area.length));
  for (const row of results) {
    console.log(`${row.area.padEnd(width)}  ${row.probe.padEnd(48)}  ${row.result}`);
  }
  console.log(`\n${results.length} observations.\n`);
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function allows(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
