import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { queueDepth, runJobs, sweep } from "@/lib/jobs";
import { registerJobHandlers } from "@/lib/jobs/handlers";
import { log } from "@/lib/logger";

/**
 * The job runner, reachable over HTTP.
 *
 * `scripts/worker.ts` is a `while` loop, and a serverless platform has no place
 * to put one: a Vercel function exists for the length of one request. Without
 * something in its place the outbox fills, automations never fire, workspace
 * deletions never complete and overdue-task notifications never arrive — while
 * every screen in the product continues to *say* those things happen. That is
 * the failure this endpoint exists to prevent.
 *
 * It does exactly what `npm run worker -- --once` does: drain until the queue is
 * empty, then stop. Scheduling is Vercel Cron's job (see `vercel.json`).
 *
 * This is deployment plumbing, not a second implementation — the claim, backoff,
 * dead-letter and idempotency logic all still live in `src/lib/jobs.ts`, and the
 * standalone worker remains the right way to run this on a normal server.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A cron invocation gets close to a minute. The drain loop below stops well
 * before this so it can return a truthful summary rather than being killed
 * mid-batch — claimed-but-unfinished jobs would be picked up by the next run
 * once their claim expires, but an honest report is worth more.
 */
export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;
const BATCH = 10;

function authorized(request: Request): boolean {
  const secret = env.cronSecret;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length === 0) return false;

  // Constant-time, and length-safe: timingSafeEqual throws on a length mismatch,
  // which would itself leak the secret's length.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: Request): Promise<NextResponse> {
  if (!env.cronSecret) {
    // Fail visibly rather than quietly running unauthenticated. An unprotected
    // job runner is a free denial-of-service against the database.
    log.error("cron invoked but CRON_SECRET is not set — refusing to run");
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!authorized(request)) {
    // Deliberately no detail: this endpoint is public-routable.
    return NextResponse.json(
      { ok: false },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  registerJobHandlers();

  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  let dead = 0;
  let batches = 0;
  let drained = false;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const result = await runJobs(BATCH);
    batches += 1;
    processed += result.processed;
    failed += result.failed;
    dead += result.dead;

    if (result.processed + result.failed + result.dead === 0) {
      drained = true;
      break;
    }
  }

  // Retention sweeps are cheap but not free, and they do not need to run on the
  // same cadence as the queue. `?sweep=1` is scheduled separately in vercel.json.
  let swept: Record<string, number> | undefined;
  if (new URL(request.url).searchParams.get("sweep") === "1") {
    swept = await sweep();
  }

  const depth = await queueDepth();

  if (depth.dead > 0) {
    log.warn("dead-lettered jobs are waiting", { dead: depth.dead });
  }

  const body = {
    ok: true,
    processed,
    failed,
    dead,
    batches,
    drained,
    durationMs: Date.now() - startedAt,
    queue: depth,
    ...(swept ? { swept } : {}),
  };

  log.info("cron run complete", body);

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

/** Vercel Cron issues a GET. */
export async function GET(request: Request) {
  return handle(request);
}

/** POST is accepted so the same endpoint can be driven by an external scheduler. */
export async function POST(request: Request) {
  return handle(request);
}
