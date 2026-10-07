#!/usr/bin/env node
/**
 * Document Q&A against a real model, on three documents, graded.
 *
 * ## What this answers that the test suite cannot
 *
 * `tests/security/document-retrieval-access.test.ts` proves the *structural*
 * properties with a counting stub: zero provider calls when retrieval finds
 * nothing, one call when it does, citations built from stored page provenance.
 * Those are guarantees and they hold.
 *
 * What a stub cannot answer is whether the model **declines when the evidence is
 * thin**. That is the one case retrieval cannot decide: measured on this corpus,
 * the lowest-scoring *supported* question and the highest-scoring *unsupported*
 * one score **identically** — 0.832, coverage 0.200, on both axes — so no
 * threshold separates them and the refusal has to come from the model. This
 * script is how that gets checked.
 *
 * Deliberately a script and not a test: it costs real money per run and needs a
 * key, so it must never run in CI.
 *
 *   npm run docqa:check                # the real thing, costs money
 *   npm run docqa:check -- --dry-run   # retrieval and citations only, free
 *
 * Run through the npm script rather than node directly: it needs
 * `--require ./scripts/allow-server-modules.cjs` for the `server-only` guard,
 * and tsx to resolve the `@/` path aliases. `worker` sets the same flag for the
 * same reason.
 *
 * Needs, and refuses without:
 *   - ANTHROPIC_API_KEY, in .env — set it with
 *     `node scripts/set-local-anthropic-key.mjs`, which validates it first
 *   - object storage, started automatically from `scripts/storage-env.mjs`
 *
 * ## Grading
 *
 * A `supported` case must contain the expected fact **and** cite the expected
 * page. A citation naming the wrong page fails even when the fact is right: a
 * page number the reader cannot check is worse than no page number.
 *
 * An `unsupported` or `misleading` case must decline. Declining is detected
 * structurally where possible — zero passages means the deterministic refusal,
 * which is a guarantee rather than a judgement — and otherwise by looking for
 * an explicit statement that the document does not say, plus the absence of any
 * figure that would be a fabrication. Every answer is printed in full, because
 * automated grading of prose is a screen and not a verdict.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");

// .env.local first so a key placed there also works, then .env. Override, because
// .env ships ANTHROPIC_API_KEY as an empty string and an empty value must lose.
require("dotenv").config({ path: [".env.local", ".env"], override: true });

/**
 * `--dry-run` does everything except call the model: builds the documents,
 * uploads them through the presigned PUT, ingests, retrieves, and grades
 * retrieval and citation pages. It needs no key and spends nothing, and it is
 * what proves the corpus is dense enough for page-level citations. It cannot
 * answer the question this script exists for — whether the model declines on
 * thin evidence — and says so at the end.
 */
const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
  console.error(
    "\nNo ANTHROPIC_API_KEY.\n\n" +
      "  Set it with:\n" +
      "      node scripts/set-local-anthropic-key.mjs\n\n" +
      "  That reads it from a hidden prompt, refuses a truncated paste, and\n" +
      "  checks it against the API before writing. Editing .env by hand has\n" +
      "  silently produced a 31-character value twice.\n",
  );
  process.exit(1);
}
/**
 * Object storage, through the same helper the three test runners use.
 *
 * This used to demand a pre-set `S3_ENDPOINT` and exit if it was missing, which
 * meant the script failed with "No S3_ENDPOINT" on a machine where MinIO was
 * already running — the variables live in `scripts/minio.mjs env`, not in the
 * shell. `storageEnvFor()` is the one place that reconciles those: it honours an
 * endpoint an operator has already set, starts MinIO when one is installed, and
 * returns nothing when neither is available.
 */
const { storageEnvFor } = await import("./storage-env.mjs");
Object.assign(process.env, await storageEnvFor());

if (!process.env.S3_ENDPOINT) {
  console.error(
    "\nNo object storage available, so there is nothing to upload to.\n" +
      "  brew install minio && node scripts/minio.mjs start\n",
  );
  process.exit(1);
}

/**
 * Refuse anything that is not a local endpoint.
 *
 * This script creates accounts, uploads documents and ingests them. None of
 * that belongs in a production bucket, and `storageEnvFor()` will hand back
 * whatever `S3_ENDPOINT` happens to be set — including a real one. So the
 * decision is made here rather than trusted: loopback only.
 */
const endpointHost = new URL(process.env.S3_ENDPOINT).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpointHost)) {
  console.error(
    `\nRefusing to run: S3_ENDPOINT points at ${endpointHost}, which is not local.\n` +
      "This script writes documents and would be writing them to that bucket.\n" +
      "Unset S3_ENDPOINT to use MinIO, or point it at a local endpoint.\n",
  );
  process.exit(1);
}
console.log(`object storage: ${process.env.S3_ENDPOINT} (bucket ${process.env.STORAGE_BUCKET})`);

const DB = process.env.DOCQA_DB ?? resolve(ROOT, ".docqa-check.db");
process.env.DATABASE_URL = `file:${DB}`;
process.env.AUTH_SECRET ??= "local-doc-qa-check-secret-of-sufficient-length";
process.env.APP_URL ??= "http://localhost:3123";

if (!existsSync(DB)) {
  console.log("preparing a throwaway database…");
  execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: ROOT, stdio: "inherit" });
}

const { CORPUS } = await import("../tests/fixtures/documents/corpus.ts");
const { buildPdf } = await import("../tests/helpers/pdf-fixture.ts");
const { db } = await import("../src/lib/db.ts");
const { withTenantContext } = await import("../src/lib/tenant-db.ts");
const { getStorage } = await import("../src/lib/storage.ts");
const { ingestFileAsset } = await import("../src/lib/documents/ingest.ts");
const { retrievePassages } = await import("../src/lib/documents/retrieve.ts");
const { answerFromDocument, unsupportedAnswer, resolveDocumentProvider } =
  await import("../src/lib/ai/document-agent.ts");

/** A world an ordinary Pro customer would have. */
async function world() {
  const owner = await db.user.create({
    data: {
      email: `docqa-${randomUUID().slice(0, 8)}@local.test`,
      name: "Doc QA",
      passwordHash: "not-used",
      emailVerifiedAt: new Date(),
      plan: "pro",
    },
  });
  const workspace = await db.workspace.create({
    data: { name: "Doc QA", ownerId: owner.id, slug: `docqa-${randomUUID().slice(0, 8)}` },
  });
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: "owner" },
  });
  for (const key of ["files", "ai", "documentAi"]) {
    await db.featureFlag.create({
      data: { key, workspaceId: workspace.id, enabled: true, description: "doc QA model check" },
    });
  }
  const project = await db.project.create({
    data: { workspaceId: workspace.id, name: "Model check", ownerId: owner.id },
  });
  return { owner, workspace, project };
}

const { owner, workspace, project } = await world();
const scope = { workspaceIds: [workspace.id], userId: owner.id, restrictedWorkspaceIds: [] };

let provider = null;
if (!dryRun) {
  const resolved = await withTenantContext(scope, () => resolveDocumentProvider(workspace.id));
  if (!resolved.capable) {
    console.error(`\nThe resolved provider (${resolved.provider.id}) is not model-backed. Nothing to check.\n`);
    process.exit(1);
  }
  provider = resolved.provider;
  console.log(`provider: ${provider.id}\n`);
} else {
  console.log("DRY RUN — retrieval and citations only, no model call, nothing spent\n");
}

const storage = getStorage();
let pass = 0;
let fail = 0;
const failures = [];

for (const document of CORPUS) {
  console.log("=".repeat(76));
  console.log(document.name);
  console.log("=".repeat(76));

  const bytes = buildPdf(document.pages);
  const key = `workspaces/${workspace.id}/${randomUUID()}.pdf`;
  // Uploaded through the presigned PUT, exactly as a browser would, so the
  // bytes the scanner and the extractor see are the bytes storage returns.
  const contract = await storage.createUploadUrl({
    key,
    contentType: "application/pdf",
    downloadName: document.name,
  });
  const put = await fetch(contract.url, {
    method: contract.method,
    headers: contract.headers ?? {},
    body: bytes,
  });
  if (!put.ok) throw new Error(`storage PUT failed: ${put.status} ${await put.text()}`);

  const file = await db.fileAsset.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: document.name,
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      storageKey: key,
      uploaderId: owner.id,
    },
  });

  await withTenantContext(scope, () =>
    ingestFileAsset({ fileAssetId: file.id, workspaceId: workspace.id }),
  );
  const ingestion = await db.documentIngestion.findFirst({
    where: { fileAssetId: file.id },
    select: { status: true, pageCount: true, chunkCount: true },
  });
  console.log(`ingested: ${ingestion?.status} — ${ingestion?.pageCount} pages, ${ingestion?.chunkCount} chunks\n`);
  if (ingestion?.status !== "ready") {
    failures.push(`${document.name}: ingestion ${ingestion?.status}`);
    fail += 1;
    continue;
  }

  for (const expected of document.expectations) {
    const result = await withTenantContext(scope, () =>
      retrievePassages({ fileAssetId: file.id, workspaceId: workspace.id, question: expected.question }),
    );

    let answer;
    let calledModel = false;
    if (result.passages.length === 0) {
      answer = unsupportedAnswer(document.name, result);
    } else if (dryRun) {
      answer = "(dry run — the model was not called)";
    } else {
      calledModel = true;
      let out = "";
      for await (const chunk of answerFromDocument({
        workspaceId: workspace.id,
        fileName: document.name,
        question: expected.question,
        result,
        provider,
      })) {
        out += chunk;
      }
      // NOT `out + buildCitations(...)`. `answerFromDocument` yields the
      // citations as its own final chunk (document-agent.ts:226), so appending
      // them here printed every Sources block twice — which looked like a
      // product defect in the first run of this script and was this line.
      answer = out;
    }

    const pages = [...new Set(result.passages.map((p) => [p.pageStart, p.pageEnd]))];
    const verdict = grade(expected, answer, result, calledModel);
    if (verdict.ok) pass += 1;
    else {
      fail += 1;
      failures.push(`${document.name} — "${expected.question}": ${verdict.why}`);
    }

    console.log(`${verdict.ok ? "ok  " : "FAIL"}  [${expected.kind}] ${expected.question}`);
    if (expected.note) console.log(`        note: ${expected.note}`);
    console.log(`        retrieval: ${result.passages.length} passage(s)${pages.length ? ` from pages ${pages.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(", ")}` : ""}; model called: ${calledModel}`);
    if (!verdict.ok) console.log(`        why: ${verdict.why}`);
    console.log(`        ${answer.replace(/\n/g, "\n        ")}\n`);
  }
}

/** A screen, not a verdict. Every answer is printed for reading. */
function grade(expected, answer, result, calledModel) {
  const text = answer.toLowerCase();

  if (expected.kind === "supported") {
    // In a dry run the fact can only be checked against the retrieved text,
    // which is what retrieval is responsible for; the wording is the model's.
    if (dryRun && expected.fact) {
      // Concatenated, because de-overlap removes text from a later passage that
      // the preceding one already carried — the model still reads it, so
      // checking each passage in isolation would fail on a correct retrieval.
      const combined = result.passages.map((p) => p.text).join("\n");
      if (!combined.includes(expected.fact)) {
        return { ok: false, why: `the retrieved text does not contain "${expected.fact}"` };
      }
    }
    if (!dryRun && expected.fact) {
      // Alternatives, because the document says "thirty percent" and a correct
      // answer may well say "30%". A grader that only accepts the document's
      // own wording marks a right answer wrong, which is worse than useless —
      // it hides the cases that are genuinely wrong among the ones that are not.
      const accepted = [expected.fact, ...(expected.alsoAccept ?? [])];
      const found = accepted.some((f) => answer.toLowerCase().includes(f.toLowerCase()));
      if (!found) {
        return { ok: false, why: `answer contains none of ${JSON.stringify(accepted)}` };
      }
    }
    if (expected.page !== undefined) {
      const cited = result.passages.some(
        (p) => p.pageStart <= expected.page && expected.page <= p.pageEnd,
      );
      if (!cited) return { ok: false, why: `no cited passage covers page ${expected.page}` };
    }
    if (!dryRun && !calledModel) return { ok: false, why: "refused a question the document answers" };
    if (dryRun && result.passages.length === 0) {
      return { ok: false, why: "retrieval found nothing for a question the document answers" };
    }
    return { ok: true };
  }

  // unsupported / misleading
  if (dryRun) {
    // Retrieval alone cannot decide these — that is the finding. Report which
    // ones reach the model rather than pretending to grade them.
    return { ok: true, why: result.passages.length === 0 ? "refused structurally" : "reaches the model" };
  }
  if (!calledModel) {
    // The deterministic refusal. A guarantee rather than a judgement.
    return { ok: true };
  }
  const declines =
    /\b(does not|doesn't|cannot|can't|no mention|not (?:stated|specified|mentioned|addressed|given|covered)|nothing (?:about|in)|i (?:could|couldn)'?t find|silent on)\b/.test(text);
  if (!declines) {
    return { ok: false, why: "the model answered rather than declining, and retrieval found evidence" };
  }
  return { ok: true };
}

console.log("=".repeat(76));
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
if (dryRun) {
  console.log(
    "\nDRY RUN. Retrieval and citation pages were graded; the refusal behaviour was\n" +
      "NOT tested, because that is the model's job and no model was called. Re-run\n" +
      "without --dry-run, with a key in .env, to check it.\n",
  );
} else {
  console.log(
    "\nRead the answers above rather than trusting the counts: declining is prose,\n" +
      "and a grader looking for phrases is a screen.\n",
  );
}
process.exit(fail === 0 ? 0 : 1);
