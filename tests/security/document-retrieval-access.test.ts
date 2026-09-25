import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createTenant, cleanupTenants, db as observer, membershipIdFor, type Tenant,
} from "../helpers/fixtures";
import { POST as aiChat } from "../../src/app/api/ai/chat/route";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import {
  setProviderForTests, resetProvider, installedProviderForTests,
} from "../../src/lib/ai/provider";
import type { AiProvider, CompleteOptions } from "../../src/lib/ai/provider";
import { isPostgres } from "../../src/lib/env";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Who may ask Tiny about a document, and what it may answer from.
 *
 * The headline assertion is the refusal invariant: when retrieval finds no
 * evidence, the provider is invoked **zero times**. That is asserted by counting
 * invocations on an installed provider, not by pattern-matching the response —
 * a refusal the model produced reads identically to one it was never asked for,
 * and only one of those is a guarantee.
 *
 * The counter is proven live by the positive case in the same suite: a supported
 * question must show exactly one invocation. If the seam stopped working, that
 * test fails rather than the zero-call test silently passing.
 *
 * PostgreSQL is where the tenant assertions mean anything. SQLite has no
 * policies, so the isolation cases skip there — which is why they are here and
 * not only in an integration suite.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;
let B: Tenant;

const id = {
  grantedProject: "",
  ungrantedProject: "",
  readyFile: "",
  ungrantedFile: "",
  notReadyFile: "",
  foreignFile: "",
};

/** A provider that records every call and never reaches a network. */
class CountingProvider implements AiProvider {
  // Not "offline": aiPermission() denies transmission when the *configured*
  // provider is offline, which it is in tests. The seam short-circuits that, but
  // naming a real provider keeps the object honest about what it stands for.
  readonly id = "anthropic" as const;
  readonly model = "counting-test-provider";
  calls: CompleteOptions[] = [];

  async complete(options: CompleteOptions) {
    this.calls.push(options);
    return { text: "counted", model: this.model, provider: this.id, inputTokens: 0, outputTokens: 0 };
  }
  async *stream(options: CompleteOptions) {
    this.calls.push(options);
    yield "counted answer";
  }
}

let provider: CountingProvider;

/** Creates a file with an ingestion and chunks whose text we control. */
async function makeDocument(
  tenant: Tenant,
  projectId: string | null,
  label: string,
  status: string,
  chunks: Array<{ ordinal: number; text: string; pageStart: number; pageEnd: number }>,
): Promise<string> {
  const file = await observer.fileAsset.create({
    data: {
      workspaceId: tenant.workspaceId,
      name: `${label}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 4096,
      storageKey: `workspaces/${tenant.workspaceId}/${label}-${Date.now()}-${Math.random()}.pdf`,
      projectId,
    },
    select: { id: true },
  });

  const ingestion = await observer.documentIngestion.create({
    data: {
      fileAssetId: file.id,
      workspaceId: tenant.workspaceId,
      status,
      pageCount: 9,
      charCount: chunks.reduce((n, c) => n + c.text.length, 0),
      chunkCount: chunks.length,
    },
    select: { id: true },
  });

  if (chunks.length > 0) {
    await observer.documentChunk.createMany({
      data: chunks.map((c) => ({
        workspaceId: tenant.workspaceId,
        fileAssetId: file.id,
        ingestionId: ingestion.id,
        ordinal: c.ordinal,
        text: c.text,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        charCount: c.text.length,
        tokenEstimate: Math.ceil(c.text.length / 4),
      })),
    });
  }
  return file.id;
}

/** The chunk text every positive assertion is checked against. */
const READY_CHUNKS = [
  { ordinal: 0, pageStart: 1, pageEnd: 2,
    text: "Section 1. Introduction to the programme and its objectives." },
  { ordinal: 1, pageStart: 3, pageEnd: 4,
    text: "Section 2. The submission deadline is 28 September 2026 at 3:00 PM Pacific Time." },
  { ordinal: 2, pageStart: 7, pageEnd: 7,
    text: "Section 3. Insurance: the contractor shall maintain general liability coverage." },
];

async function ask(userId: string, fileAssetId: string, question: string) {
  await resetRateLimit("ai", { user: userId });
  await resetRateLimit("aiHourly", { user: userId });
  provider.calls = [];
  const response = await runAsTestIdentity(userId, () =>
    aiChat(new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, focus: { type: "fileAsset", id: fileAssetId } }),
    })));
  const body = await response.text();
  return { status: response.status, body, calls: provider.calls.length };
}

async function setFlag(workspaceId: string, key: string, enabled: boolean) {
  await observer.featureFlag.upsert({
    where: { key_workspaceId: { key, workspaceId } },
    create: { key, enabled, workspaceId },
    update: { enabled },
  });
}

before(async () => {
  A = await createTenant("DocRetrieveA");
  B = await createTenant("DocRetrieveB");

  id.grantedProject = A.projectId;
  id.ungrantedProject = (await observer.project.create({
    data: { workspaceId: A.workspaceId, name: "Project not granted" },
    select: { id: true },
  })).id;

  id.readyFile = await makeDocument(A, id.grantedProject, "ready-doc", "ready", READY_CHUNKS);
  id.ungrantedFile = await makeDocument(A, id.ungrantedProject, "ungranted-doc", "ready", READY_CHUNKS);
  id.notReadyFile = await makeDocument(A, id.grantedProject, "scanned-doc", "no_text", []);
  id.foreignFile = await makeDocument(B, B.projectId, "foreign-doc", "ready", READY_CHUNKS);

  await observer.workspaceMember.updateMany({
    where: { workspaceId: A.workspaceId, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  await observer.recordGrant.create({
    data: {
      workspaceId: A.workspaceId, userId: A.memberId,
      membershipId: await membershipIdFor(A.workspaceId, A.memberId),
      anchorType: "project", anchorId: id.grantedProject, grantedById: A.ownerId,
    },
  });
});

after(async () => {
  resetProvider();
  await cleanupTenants([A, B]);
  await observer.$disconnect();
});

beforeEach(async () => {
  provider = new CountingProvider();
  setProviderForTests(provider);
  for (const key of ["files", "ai", "documentAi"]) await setFlag(A.workspaceId, key, true);
  for (const key of ["files", "ai", "documentAi"]) await setFlag(B.workspaceId, key, true);
});

describe("the refusal invariant", () => {
  test("a supported question calls the provider exactly once", async () => {
    // The control that keeps the zero-call test honest. If the counting seam
    // broke, this fails instead of the next test passing for the wrong reason.
    const r = await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.equal(r.calls, 1, "the installed provider was not reached — the seam is broken");
  });

  test("an unsupported question calls the provider ZERO times", async () => {
    const r = await ask(A.ownerId, id.readyFile, "What bid bond amount is required?");
    assert.equal(r.status, 200);
    assert.equal(r.calls, 0,
      "the provider was invoked for a question the document does not support — " +
      "it had an opportunity to answer from general knowledge");
    assert.match(r.body, /couldn't find anything about that/);
  });

  test("the refusal names the document and the corpus, and cites nothing", async () => {
    const r = await ask(A.ownerId, id.readyFile, "What bid bond amount is required?");
    assert.match(r.body, /ready-doc\.pdf/);
    assert.ok(!r.body.includes("Sources"), "a refusal carried a sources block");
  });

  test("a question of only stopwords calls the provider zero times", async () => {
    const r = await ask(A.ownerId, id.readyFile, "what about the and for this");
    assert.equal(r.calls, 0);
    assert.match(r.body, /couldn't tell what to look for/);
  });

  test("an ingestion that is not ready is never evidence, and calls nothing", async () => {
    const r = await ask(A.ownerId, id.notReadyFile, "What is the submission deadline?");
    assert.equal(r.calls, 0, "a non-ready document reached the provider");
    assert.match(r.body, /haven't been able to read/);
  });
});

describe("grounding and citations", () => {
  test("the answer carries a citation built from the chunk's stored pages", async () => {
    const r = await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
    // The deadline lives on the chunk spanning pages 3-4. The citation must say
    // so, and the page numbers must come from the row rather than the model —
    // the counting provider returns a fixed string containing no page at all.
    assert.match(r.body, /Sources/);
    assert.match(r.body, /ready-doc\.pdf — pp\. 3–4/);
    assert.ok(!r.body.includes("p. 9"), "a page outside the matched chunk was cited");
  });

  test("the model output contains no page number of its own", async () => {
    const r = await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
    const [answer] = r.body.split("\n\nSources");
    assert.ok(!/\bp{1,2}\.\s*\d/.test(answer!), "a page citation appeared in the model's own output");
  });

  test("document text reaches the provider inside the untrusted boundary", async () => {
    await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
    const sent = provider.calls[0]!.messages.map((m) => m.content).join("\n");
    assert.match(sent, /<crm_context>/);
    assert.match(sent, /<\/crm_context>/);
    const inside = sent.slice(sent.indexOf("<crm_context>"), sent.indexOf("</crm_context>"));
    assert.ok(inside.includes("submission deadline is 28 September 2026"),
      "the document text was not inside <crm_context>");
  });

  test("only matching passages are sent, not the whole document", async () => {
    await ask(A.ownerId, id.readyFile, "What insurance is required?");
    const sent = provider.calls[0]!.messages.map((m) => m.content).join("\n");
    assert.ok(sent.includes("general liability coverage"), "the matching passage was not sent");
    assert.ok(!sent.includes("Introduction to the programme"),
      "a non-matching passage was sent — retrieval is not narrowing anything");
  });
});

describe("the three gates", () => {
  for (const flag of ["files", "ai", "documentAi"]) {
    test(`${flag} = false refuses, and calls nothing`, pgOnly, async () => {
      await setFlag(A.workspaceId, flag, false);
      const r = await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
      assert.equal(r.status, 403, `${flag} off did not refuse (status ${r.status}): ${r.body.slice(0, 160)}`);
      assert.equal(r.calls, 0, `${flag} off still reached the provider`);
    });
  }

  test("a workspace override is observed under row-level security", pgOnly, async () => {
    // The defect this codebase has had three times: a workspace-scoped flag read
    // outside a tenant context is filtered by RLS and falls back to the default.
    await setFlag(A.workspaceId, "documentAi", false);
    const r = await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
    assert.equal(r.status, 403, "the workspace override was not observed");
  });
});

describe("authorization", () => {
  test("a member with ai:use can query a file they can reach", async () => {
    // A.memberId is restricted but granted the project this file belongs to.
    const r = await ask(A.memberId, id.readyFile, "What is the submission deadline?");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.equal(r.calls, 1);
  });

  test("a viewer is refused, because viewer has no ai:use", async () => {
    const r = await ask(A.viewerId, id.readyFile, "What is the submission deadline?");
    assert.notEqual(r.status, 200, "a viewer got a document answer");
    assert.equal(r.calls, 0, "a viewer reached the provider");
  });

  test("a restricted member cannot query a file on an ungranted project", pgOnly, async () => {
    const r = await ask(A.memberId, id.ungrantedFile, "What is the submission deadline?");
    assert.notEqual(r.status, 200, "a restricted member read an ungranted project's document");
    assert.equal(r.calls, 0);
  });

  test("a known FileAsset id from another workspace is refused", pgOnly, async () => {
    const r = await ask(A.ownerId, id.foreignFile, "What is the submission deadline?");
    assert.notEqual(r.status, 200, "a foreign workspace's document was answered");
    assert.equal(r.calls, 0);
  });

  test("a foreign id and a nonexistent id are indistinguishable", pgOnly, async () => {
    const foreign = await ask(A.ownerId, id.foreignFile, "What is the submission deadline?");
    const missing = await ask(A.ownerId, "cmzzzzzzzzzzzzzzzzzzzzzzzz", "What is the submission deadline?");
    assert.equal(foreign.status, missing.status,
      `foreign ${foreign.status} vs nonexistent ${missing.status} — the difference leaks existence`);
    assert.deepEqual(JSON.parse(foreign.body).error, JSON.parse(missing.body).error,
      "the messages differ, which leaks whether the id exists");
  });

  test("the caller cannot supply a workspace id at all", () => {
    // The trust boundary as a shape: the request schema has no workspace field,
    // so there is nothing to forge. Asserted on the source because the absence
    // of an input is not observable at runtime.
    const source = readFileSync("src/app/api/ai/chat/route.ts", "utf8");
    const start = source.indexOf("const bodySchema");
    // The schema block only: everything up to its own closing `});`.
    const schema = source.slice(start, source.indexOf("\n});", start));
    assert.ok(schema.includes("question:") && schema.includes("focus:"),
      "the schema slice missed the body schema — update this test");
    assert.ok(!/workspaceId/.test(schema), "the request body accepts a workspaceId");
    assert.ok(!/projectId|chunkId|ingestionId|pageStart/.test(schema),
      "the request body accepts a tenant-scoping or provenance identifier");
  });
});

describe("the counting seam cannot affect production", () => {
  test("nothing is installed once a test clears it", () => {
    setProviderForTests(null);
    assert.equal(installedProviderForTests(), null);
    // Reinstate for the remaining tests in this file.
    setProviderForTests(provider);
  });

  test("resetProvider clears it too", () => {
    resetProvider();
    assert.equal(installedProviderForTests(), null,
      "a leaked installed provider would bypass the AI privacy path");
    setProviderForTests(provider);
  });

  test("only a test file ever installs one", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !full.includes("/generated/")) {
          if (/setProviderForTests\s*\(/.test(readFileSync(full, "utf8"))) {
            offenders.push(full.replace(process.cwd() + "/", ""));
          }
        }
      }
    };
    walk(resolve(process.cwd(), "src"));
    assert.deepEqual(offenders.filter((f) => f !== "src/lib/ai/provider.ts"), [],
      "application code installs a test provider, which would bypass the privacy path");
  });
});

describe("retrieval writes nothing", () => {
  test("asking a question does not change the intelligence corpus", async () => {
    const before = await observer.$transaction([
      observer.documentIngestion.count(),
      observer.documentChunk.count(),
      observer.fileAsset.count(),
    ]);

    await ask(A.ownerId, id.readyFile, "What is the submission deadline?");
    await ask(A.ownerId, id.readyFile, "What bid bond amount is required?");

    const after = await observer.$transaction([
      observer.documentIngestion.count(),
      observer.documentChunk.count(),
      observer.fileAsset.count(),
    ]);
    assert.deepEqual(after, before, "retrieval wrote to the corpus");
  });
});
