import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  createTenant,
  cleanupTenants,
  db as observer,
  membershipIdFor,
  type Tenant,
} from "../helpers/fixtures";

const require = createRequire(import.meta.url);

/**
 * Who can read a document's extracted text.
 *
 * Extracted text is the most sensitive thing this product stores. A contact row
 * leaks a name; a chunk row leaks whatever was inside somebody's contract. The
 * rule the policies implement, and the rule these tests attack:
 *
 *   You may read a document's intelligence exactly when you may read the
 *   document.
 *
 * Not "when you are in the same workspace". FileAsset is subject to the
 * record-level scope as well as the workspace one, so a restricted member who
 * was never granted a project cannot see files attached to it — and must not be
 * able to read the text extracted from them either.
 *
 * These connect to PostgreSQL **directly**, as the restricted `tinycrm_app`
 * role, with no Prisma and no application code in the path. That is the only
 * way to test the second layer: the application's own helpers always add the
 * workspace filter that the policies exist to survive without.
 *
 * Skipped on SQLite, which has no policies at all. That is not a technicality —
 * it is why the feature-flag defect in this codebase survived CI twice.
 */

const APP_URL = process.env.RLS_APP_DATABASE_URL;
const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const enabled = isPostgres && Boolean(APP_URL);
const pgOnly = enabled ? undefined : { skip: "PostgreSQL with RLS_APP_DATABASE_URL only" };

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** A raw connection as the restricted role — no Prisma, no application filters. */
async function asAppRole<T>(
  fn: (query: Query) => Promise<T>,
  context?: { workspaceIds: string[]; userId?: string; restricted?: string[] },
): Promise<T> {
  const { Client } = require("pg");
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (context) {
      await client.query("SELECT set_config('app.workspace_ids', $1, true)", [
        context.workspaceIds.join(","),
      ]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId ?? ""]);
      await client.query("SELECT set_config('app.restricted_workspace_ids', $1, true)", [
        (context.restricted ?? []).join(","),
      ]);
    }
    const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

let A: Tenant;
let B: Tenant;

const id = {
  grantedProject: "",
  ungrantedProject: "",
  grantedFile: "",
  ungrantedFile: "",
  grantedIngestion: "",
  ungrantedIngestion: "",
  grantedChunk: "",
  ungrantedChunk: "",
  foreignFile: "",
  foreignIngestion: "",
  foreignChunk: "",
};

/** Creates a file with a full set of intelligence rows attached. */
async function makeDocument(
  tenant: Tenant,
  projectId: string | null,
  label: string,
): Promise<{ fileId: string; ingestionId: string; chunkId: string }> {
  const file = await observer.fileAsset.create({
    data: {
      workspaceId: tenant.workspaceId,
      name: `${label}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 1024,
      storageKey: `workspaces/${tenant.workspaceId}/${label}-${Date.now()}.pdf`,
      projectId,
    },
    select: { id: true },
  });

  const ingestion = await observer.documentIngestion.create({
    data: {
      fileAssetId: file.id,
      workspaceId: tenant.workspaceId,
      status: "ready",
      pageCount: 3,
      charCount: 900,
      chunkCount: 1,
    },
    select: { id: true },
  });

  const chunk = await observer.documentChunk.create({
    data: {
      workspaceId: tenant.workspaceId,
      fileAssetId: file.id,
      ingestionId: ingestion.id,
      ordinal: 0,
      text: `SECRET-${label}: the confidential contents of ${label}`,
      pageStart: 1,
      pageEnd: 2,
      charCount: 48,
      tokenEstimate: 12,
    },
    select: { id: true },
  });

  return { fileId: file.id, ingestionId: ingestion.id, chunkId: chunk.id };
}

before(async () => {
  if (!enabled) return;
  A = await createTenant("DocIntelA");
  B = await createTenant("DocIntelB");

  id.grantedProject = A.projectId;
  id.ungrantedProject = (
    await observer.project.create({
      data: { workspaceId: A.workspaceId, name: "Project the member was not given" },
      select: { id: true },
    })
  ).id;

  const granted = await makeDocument(A, id.grantedProject, "granted");
  id.grantedFile = granted.fileId;
  id.grantedIngestion = granted.ingestionId;
  id.grantedChunk = granted.chunkId;

  const ungranted = await makeDocument(A, id.ungrantedProject, "ungranted");
  id.ungrantedFile = ungranted.fileId;
  id.ungrantedIngestion = ungranted.ingestionId;
  id.ungrantedChunk = ungranted.chunkId;

  const foreign = await makeDocument(B, B.projectId, "foreign");
  id.foreignFile = foreign.fileId;
  id.foreignIngestion = foreign.ingestionId;
  id.foreignChunk = foreign.chunkId;

  // The member becomes restricted, and is granted exactly one project.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: A.workspaceId, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  await observer.recordGrant.create({
    data: {
      workspaceId: A.workspaceId,
      userId: A.memberId,
      membershipId: await membershipIdFor(A.workspaceId, A.memberId),
      anchorType: "project",
      anchorId: id.grantedProject,
      grantedById: A.ownerId,
    },
  });
});

after(async () => {
  if (!enabled) return;
  await cleanupTenants([A, B]);
  await observer.$disconnect();
});

/** Whether one row of a table is visible by exact id, under a given context. */
async function visible(
  table: "DocumentIngestion" | "DocumentChunk",
  rowId: string,
  context: Parameters<typeof asAppRole>[1],
): Promise<boolean> {
  return asAppRole(async (query) => {
    const rows = await query(`SELECT id FROM "${table}" WHERE id = $1`, [rowId]);
    return rows.length > 0;
  }, context);
}

const asOwner = () => ({ workspaceIds: [A.workspaceId], userId: A.ownerId, restricted: [] });
const asMember = () => ({ workspaceIds: [A.workspaceId], userId: A.memberId, restricted: [] });
const asViewer = () => ({ workspaceIds: [A.workspaceId], userId: A.viewerId, restricted: [] });
const asRestricted = () => ({
  workspaceIds: [A.workspaceId],
  userId: A.memberId,
  restricted: [A.workspaceId],
});
const asForeigner = () => ({ workspaceIds: [B.workspaceId], userId: B.ownerId, restricted: [] });

describe("no tenant context means no rows", () => {
  test("an unfiltered select returns nothing at all", pgOnly, async () => {
    const counts = await asAppRole(async (query) => ({
      ingestions: (await query('SELECT id FROM "DocumentIngestion"')).length,
      chunks: (await query('SELECT id FROM "DocumentChunk"')).length,
    }));

    assert.deepEqual(
      counts,
      { ingestions: 0, chunks: 0 },
      "document intelligence was readable with no tenant context at all",
    );
  });

  test("naming a known id does not help", pgOnly, async () => {
    assert.equal(await visible("DocumentChunk", id.grantedChunk, undefined), false);
    assert.equal(await visible("DocumentIngestion", id.grantedIngestion, undefined), false);
  });
});

describe("inside the workspace", () => {
  test("the owner sees their documents' intelligence", pgOnly, async () => {
    assert.equal(await visible("DocumentIngestion", id.grantedIngestion, asOwner()), true);
    assert.equal(await visible("DocumentChunk", id.grantedChunk, asOwner()), true);
  });

  test("an unrestricted member sees it", pgOnly, async () => {
    assert.equal(await visible("DocumentChunk", id.grantedChunk, asMember()), true);
    assert.equal(await visible("DocumentChunk", id.ungrantedChunk, asMember()), true);
  });

  test("a viewer sees it — reading is what a viewer does", pgOnly, async () => {
    assert.equal(await visible("DocumentChunk", id.grantedChunk, asViewer()), true);
  });
});

describe("a restricted member is confined to granted projects", () => {
  test("intelligence for a granted project's document is readable", pgOnly, async () => {
    assert.equal(
      await visible("DocumentIngestion", id.grantedIngestion, asRestricted()),
      true,
      "a restricted member could not read intelligence for a document they were granted",
    );
    assert.equal(await visible("DocumentChunk", id.grantedChunk, asRestricted()), true);
  });

  test("intelligence for an ungranted project's document is not", pgOnly, async () => {
    assert.equal(
      await visible("DocumentIngestion", id.ungrantedIngestion, asRestricted()),
      false,
      "a restricted member read the ingestion record of a document they cannot open",
    );
    assert.equal(
      await visible("DocumentChunk", id.ungrantedChunk, asRestricted()),
      false,
      "a restricted member read extracted text from a document they cannot open",
    );
  });

  test("a known chunk id is not a shortcut around file access", pgOnly, async () => {
    // The specific attack this schema was shaped to defeat. The chunk carries
    // its own workspaceId, and that column alone would have been enough to pass
    // a naive workspace-only policy. The policy derives from the FileAsset, so
    // knowing the id buys nothing.
    const rows = await asAppRole(
      (query) => query('SELECT id, text FROM "DocumentChunk" WHERE id = $1', [id.ungrantedChunk]),
      asRestricted(),
    );
    assert.deepEqual(rows, [], "a chunk id retrieved text from an unreachable document");
  });

  test("a known FileAsset id is not a shortcut either", pgOnly, async () => {
    const rows = await asAppRole(
      (query) =>
        query('SELECT id FROM "DocumentChunk" WHERE "fileAssetId" = $1', [id.ungrantedFile]),
      asRestricted(),
    );
    assert.deepEqual(rows, [], "a file id retrieved text from an unreachable document");
  });

  test("an unfiltered select returns only granted documents", pgOnly, async () => {
    const texts = await asAppRole(
      (query) => query('SELECT text FROM "DocumentChunk"'),
      asRestricted(),
    );
    const leaked = texts.filter((row) => String(row.text).includes("SECRET-ungranted"));
    assert.deepEqual(leaked, [], "an unfiltered select leaked an ungranted document's text");
    assert.ok(texts.length > 0, "the restricted member saw nothing at all — the fixture is wrong");
  });

  test("a restricted member cannot write intelligence onto an unreachable document", pgOnly, async () => {
    await assert.rejects(
      () =>
        asAppRole(
          (query) =>
            query(
              'INSERT INTO "DocumentChunk" (id, "workspaceId", "fileAssetId", "ingestionId", ordinal, text, "pageStart", "pageEnd", "charCount", "tokenEstimate") ' +
                "VALUES ($1, $2, $3, $4, 99, 'injected', 1, 1, 8, 2)",
              [
                `chunk_injected_${Date.now()}`,
                A.workspaceId,
                id.ungrantedFile,
                id.ungrantedIngestion,
              ],
            ),
          asRestricted(),
        ),
      /row-level security|violates/i,
      "a restricted member inserted a chunk against a document they cannot see",
    );
  });
});

describe("another tenant", () => {
  test("cannot read intelligence across the workspace boundary", pgOnly, async () => {
    assert.equal(await visible("DocumentIngestion", id.grantedIngestion, asForeigner()), false);
    assert.equal(await visible("DocumentChunk", id.grantedChunk, asForeigner()), false);
  });

  test("and we cannot read theirs", pgOnly, async () => {
    assert.equal(await visible("DocumentChunk", id.foreignChunk, asOwner()), false);
  });

  test("claiming their workspace id in the row does not help", pgOnly, async () => {
    // A row whose workspaceId says A but whose file belongs to B cannot exist —
    // the composite foreign key refuses it. This states that as a property of
    // the database rather than of the code that writes it.
    await assert.rejects(
      () =>
        observer.documentIngestion.create({
          data: {
            fileAssetId: id.foreignFile,
            workspaceId: A.workspaceId,
            status: "ready",
          },
        }),
      "an ingestion row claimed a workspace its file does not belong to",
    );
  });
});

describe("deleting the document deletes what was extracted from it", () => {
  test("cascade removes the ingestion row and every chunk", pgOnly, async () => {
    const doomed = await makeDocument(A, id.grantedProject, "doomed");

    assert.equal(
      await observer.documentChunk.count({ where: { fileAssetId: doomed.fileId } }),
      1,
      "the fixture did not create a chunk",
    );

    await observer.fileAsset.delete({ where: { id: doomed.fileId } });

    assert.equal(
      await observer.documentIngestion.count({ where: { fileAssetId: doomed.fileId } }),
      0,
      "an ingestion record outlived its document",
    );
    assert.equal(
      await observer.documentChunk.count({ where: { fileAssetId: doomed.fileId } }),
      0,
      "extracted text outlived the document it came from",
    );
  });

  test("the cascade is structural, so it happens below the application too", pgOnly, async () => {
    // Deleted with raw SQL as the restricted role: no Prisma cascade emulation,
    // no application cleanup code. If this leaves rows behind, the cascade is
    // an application convention rather than a database guarantee.
    const doomed = await makeDocument(A, id.grantedProject, "doomed-raw");

    await asAppRole(
      (query) => query('DELETE FROM "FileAsset" WHERE id = $1', [doomed.fileId]),
      asOwner(),
    );

    assert.equal(
      await observer.documentChunk.count({ where: { fileAssetId: doomed.fileId } }),
      0,
      "a raw SQL delete left extracted text behind",
    );
  });
});
