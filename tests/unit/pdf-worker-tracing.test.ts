import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The worker file ships with the functions that need it.
 *
 * The Phase 3B spike found this the hard way. In Node, pdf.js has no real
 * Worker and loads its worker code by importing `./pdf.worker.mjs` relative to
 * itself. That import happens at runtime, so Next's file tracer never sees it,
 * so the worker is not included in the deployed function — and extraction fails
 * with "Setting up fake worker failed" on Vercel while passing everywhere else,
 * because everywhere else has node_modules on disk.
 *
 * `next.config.ts` fixes it with `serverExternalPackages` plus an explicit
 * `outputFileTracingIncludes`. This test is what stops that fix quietly
 * regressing — a Next upgrade changing glob semantics, or somebody narrowing
 * the entry list to "just the cron route" without noticing that `dispatchSoon`
 * runs jobs inside ordinary requests too.
 *
 * It reads the build output, so it needs one: skipped when `.next/server` is
 * absent, which is the case in the fast local loop and never the case in CI,
 * where `npm run build` precedes the suite.
 */

const SERVER = resolve(process.cwd(), ".next/server");
const built = existsSync(SERVER);
const needsBuild = built ? undefined : { skip: "no production build in .next/server" };

/** Every `*.nft.json` Next wrote, which is one per traced entrypoint. */
function traceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".nft.json")) found.push(full);
    }
  };
  walk(SERVER);
  return found;
}

function tracedFiles(path: string): string[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { files: string[] }).files;
}

const hasWorker = (files: string[]) => files.some((f) => /pdf\.worker\.mjs$/.test(f));

describe("pdf.js worker tracing", () => {
  test("the cron entrypoint that drains the job queue ships the worker", needsBuild, () => {
    const path = resolve(SERVER, "app/api/cron/jobs/route.js.nft.json");
    assert.ok(existsSync(path), "the cron route has no trace manifest — has it moved?");
    assert.ok(
      hasWorker(tracedFiles(path)),
      "pdf.worker.mjs is missing from /api/cron/jobs. Document ingestion will fail on Vercel " +
        "with \"Setting up fake worker failed\" while working locally. See outputFileTracingIncludes " +
        "in next.config.ts.",
    );
  });

  test("so does a page, because dispatchSoon runs jobs inside ordinary requests", needsBuild, () => {
    // Not a hypothetical: src/lib/actions/{projects,deals,tasks}.ts all call
    // dispatchSoon() after a write, and it drains whatever is pending —
    // including a file.uploaded queued earlier. Tracing the worker only into
    // the cron route would make ingestion fail intermittently, depending on
    // which path happened to claim the job.
    const path = resolve(SERVER, "app/(app)/projects/[id]/page.js.nft.json");
    assert.ok(existsSync(path), "the project page has no trace manifest — has it moved?");
    assert.ok(
      hasWorker(tracedFiles(path)),
      "pdf.worker.mjs is missing from the project page's function. A job drained by " +
        "dispatchSoon() during a request would fail to extract.",
    );
  });

  test("every server entrypoint that can run a job has it", needsBuild, () => {
    // The blanket assertion, stated as a proportion rather than a list so that
    // adding a route does not require editing this test. Middleware and the
    // instrumentation hook are excluded: middleware runs on the edge runtime
    // and the hook runs once at boot; neither drains the queue.
    const excluded = /(?:^|\/)(?:middleware|instrumentation)\.js\.nft\.json$/;
    const relevant = traceFiles().filter((f) => !excluded.test(f));
    assert.ok(relevant.length > 10, `only ${relevant.length} traces found — did the build shape change?`);

    const missing = relevant.filter((f) => !hasWorker(tracedFiles(f)));
    assert.deepEqual(
      missing.map((f) => f.replace(SERVER + "/", "")),
      [],
      "these entrypoints could run document ingestion without the pdf.js worker on disk",
    );
  });

  test("the extractor's own module is traced, not bundled", needsBuild, () => {
    // serverExternalPackages is the other half of the fix. If pdfjs-dist were
    // bundled again, the trace would point into .next/server/chunks/ instead of
    // node_modules, and the relative worker import would break even though the
    // worker file itself is present.
    const files = tracedFiles(resolve(SERVER, "app/api/cron/jobs/route.js.nft.json"));
    assert.ok(
      files.some((f) => /node_modules\/pdfjs-dist\/legacy\/build\/pdf\.mjs$/.test(f)),
      "pdfjs-dist is no longer resolved from node_modules — check serverExternalPackages",
    );
  });
});
