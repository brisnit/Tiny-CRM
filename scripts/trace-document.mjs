#!/usr/bin/env node
/**
 * Traces one uploaded document through storage, extraction and indexing.
 *
 * Answers, for a named file, the four questions that matter when a document
 * question comes back empty:
 *
 *   1. Is there a FileAsset row, and what storage key does it claim?
 *   2. Did the `file.uploaded` event get dispatched, or is it still pending?
 *   3. Is there a DocumentIngestion row, and what status — ready, failed,
 *      unsupported, no_text?
 *   4. Are there chunks, how many pages do they cover, and does a sample
 *      question actually retrieve any of them?
 *
 * Read-only. Every statement is a SELECT. The object itself is **not** fetched
 * from storage: `headObject` would need the storage credentials, and the
 * question here is about the database's view of the pipeline.
 *
 *   node scripts/trace-document.mjs "IMPORTANT INFORMATION FOR BIDDERS.pdf"
 *   node scripts/trace-document.mjs "<name>" --ask "when are bids due?"
 *
 * Not committed to the release branch. See docs/DOCUMENT-QA-ACTIVATION.md.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint"],
]);

function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

const scrub = (t) => String(t).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");

async function main() {
  const name = process.argv[2];
  const askAt = process.argv.indexOf("--ask");
  const question = askAt > -1 ? process.argv[askAt + 1] : null;
  if (!name || name.startsWith("--")) {
    throw new Error('Usage: node scripts/trace-document.mjs "<file name>" [--ask "<question>"]');
  }

  console.log(`\nTracing: ${name}`);
  console.log("=".repeat(70));

  const url = await promptHidden("Connection string (input hidden): ");
  let fp;
  try {
    fp = fingerprint(url);
  } catch {
    throw new Error("That is not a parseable connection string.");
  }
  const match = PRODUCTION_FINGERPRINTS.get(fp);
  console.log(`\n  fingerprint  ${fp}`);
  if (!match) {
    console.error(`\nREFUSED. Not a known production database. Nothing was read.\n`);
    process.exit(1);
  }
  console.log(`  identified   ${match}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    // --- 1. Storage ---------------------------------------------------
    console.log("\n  1. FILE ASSET");
    const files = await client.query(
      `SELECT f."id", f."name", f."mimeType", f."sizeBytes", f."storageKey",
              f."projectId", f."workspaceId", f."createdAt", w."name" AS workspace
         FROM "FileAsset" f JOIN "Workspace" w ON w."id" = f."workspaceId"
        WHERE f."name" = $1 OR f."name" ILIKE $2
        ORDER BY f."createdAt" DESC`,
      [name, `%${name}%`],
    );
    if (files.rows.length === 0) {
      console.log(`    NO FileAsset row matching ${JSON.stringify(name)}.`);
      console.log("    The upload never completed — confirmUpload refused it, or it was deleted.");
      return;
    }
    for (const f of files.rows) {
      console.log(`    id          ${f.id}`);
      console.log(`    name        ${f.name}`);
      console.log(`    mime        ${f.mimeType}`);
      console.log(`    size        ${f.sizeBytes} bytes`);
      console.log(`    workspace   ${f.workspace} (${f.workspaceId})`);
      console.log(`    project     ${f.projectId ?? "(not on a project)"}`);
      console.log(`    created     ${f.createdAt?.toISOString?.() ?? f.createdAt}`);
      // The key's shape, not the key: it is a path into the bucket.
      console.log(`    storageKey  ${f.storageKey ? `present (${f.storageKey.length} chars)` : "MISSING"}`);
    }
    const file = files.rows[0];

    // --- 2. The event -------------------------------------------------
    console.log("\n  2. INGESTION EVENT (file.uploaded)");
    const events = await client.query(
      `SELECT "id", "status", "attempts", "processedAt", "availableAt", "lastError", "deadAt", "createdAt"
         FROM "DomainEvent"
        WHERE "name" = 'file.uploaded' AND "entityId" = $1
        ORDER BY "createdAt" DESC`,
      [file.id],
    );
    if (events.rows.length === 0) {
      console.log("    NO file.uploaded event. Nothing would ever have ingested this document.");
    }
    for (const e of events.rows) {
      console.log(`    status       ${e.status}`);
      console.log(`    attempts     ${e.attempts}`);
      console.log(`    processedAt  ${e.processedAt?.toISOString?.() ?? "NULL — never drained"}`);
      console.log(`    deadAt       ${e.deadAt?.toISOString?.() ?? "NULL"}`);
      if (e.lastError) console.log(`    lastError    ${scrub(e.lastError).slice(0, 300)}`);
    }

    // --- 3. Extraction ------------------------------------------------
    console.log("\n  3. EXTRACTION");
    const ingestions = await client.query(
      `SELECT "id", "status", "errorCode", "pageCount", "chunkCount", "charCount",
              "attempts", "extractorVersion", "warnings",
              "requestedAt", "startedAt", "finishedAt"
         FROM "DocumentIngestion" WHERE "fileAssetId" = $1 ORDER BY "requestedAt" DESC`,
      [file.id],
    );
    if (ingestions.rows.length === 0) {
      console.log("    NO DocumentIngestion row — the document was never read.");
      console.log("    Either the event is still pending, or a gate refused:");
      console.log("    files AND ai AND documentAi must all be on, and the owner's plan");
      console.log("    must grant documentQa.");
    }
    for (const i of ingestions.rows) {
      console.log(`    status       ${i.status}${i.errorCode ? ` (${i.errorCode})` : ""}`);
      console.log(`    pages        ${i.pageCount ?? "—"}`);
      console.log(`    chunks       ${i.chunkCount ?? "—"}`);
      console.log(`    chars        ${i.charCount ?? "—"}`);
      console.log(`    attempts     ${i.attempts}`);
      console.log(`    extractor    ${i.extractorVersion ?? "—"}`);
      console.log(`    requested    ${i.requestedAt?.toISOString?.() ?? i.requestedAt}`);
      console.log(`    started      ${i.startedAt?.toISOString?.() ?? "NULL"}`);
      console.log(`    finished     ${i.finishedAt?.toISOString?.() ?? "NULL"}`);
      if (i.warnings && i.warnings !== "[]") console.log(`    warnings     ${String(i.warnings).slice(0, 300)}`);
    }

    // --- 4. Indexing --------------------------------------------------
    console.log("\n  4. INDEX (chunks)");
    const chunks = await client.query(
      `SELECT "ordinal", "pageStart", "pageEnd", length("text") AS chars
         FROM "DocumentChunk" WHERE "fileAssetId" = $1 ORDER BY "ordinal"`,
      [file.id],
    );
    if (chunks.rows.length === 0) {
      console.log("    NO chunks. Retrieval has nothing to search, so every question");
      console.log("    about this document returns the 'not ready' refusal.");
    } else {
      console.log(`    ${chunks.rows.length} chunk(s):`);
      for (const c of chunks.rows) {
        console.log(`      ${String(c.ordinal).padStart(3)}  pages ${c.pageStart}-${c.pageEnd}  ${c.chars} chars`);
      }
    }

    // --- 5. Retrieval, if asked ---------------------------------------
    if (question && chunks.rows.length > 0) {
      console.log(`\n  5. RETRIEVAL for ${JSON.stringify(question)}`);
      // Word-boundary matching in SQL is not what the app does — the app scores
      // in application code. This is a coarse "is the vocabulary even present"
      // probe, and says so.
      const terms = question
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3);
      for (const term of terms.slice(0, 8)) {
        const hit = await client.query(
          `SELECT count(*)::int AS n FROM "DocumentChunk"
            WHERE "fileAssetId" = $1 AND "text" ILIKE $2`,
          [file.id, `%${term}%`],
        );
        console.log(`      ${term.padEnd(18)} appears in ${hit.rows[0].n} chunk(s)`);
      }
      console.log("    (A substring probe, not the app's scorer — it tells you whether the");
      console.log("     words are in the text at all, which is the question when an answer")
      console.log("     comes back empty.)");
    }

    // --- 6. The gates -------------------------------------------------
    console.log("\n  6. GATES FOR THIS WORKSPACE");
    const flags = await client.query(
      `SELECT "key", "enabled", "workspaceId" IS NULL AS global
         FROM "FeatureFlag"
        WHERE "key" = ANY($1) AND ("workspaceId" = $2 OR "workspaceId" IS NULL)
        ORDER BY global DESC, "key"`,
      [["files", "ai", "documentAi"], file.workspaceId],
    );
    for (const key of ["files", "ai", "documentAi"]) {
      const rows = flags.rows.filter((r) => r.key === key);
      const ws = rows.find((r) => !r.global);
      const gl = rows.find((r) => r.global);
      const effective = ws ? ws.enabled : gl ? gl.enabled : key === "ai";
      console.log(
        `    ${key.padEnd(11)} effective=${effective}` +
          `  (workspace row: ${ws ? ws.enabled : "none"}, global row: ${gl ? gl.enabled : "none"})`,
      );
    }
    const owner = await client.query(
      `SELECT u."plan" FROM "Workspace" w JOIN "User" u ON u."id" = w."ownerId" WHERE w."id" = $1`,
      [file.workspaceId],
    );
    const stored = owner.rows[0]?.plan;
    const resolved = { lifetime: "legacy_lifetime" }[stored] ?? stored;
    const entitled = ["pro", "legacy_pro", "legacy_lifetime"].includes(resolved);
    console.log(`    owner plan  ${stored} -> ${resolved}  documentQa=${entitled}`);
  } finally {
    await client.end();
  }
  console.log("\n  Read-only. Nothing was changed.\n");
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
