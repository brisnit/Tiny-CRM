/**
 * The background worker.
 *
 *   npm run worker              # run until stopped
 *   npm run worker -- --once    # drain the queue once and exit (for cron)
 *
 * Runs the job loop and periodic maintenance. Safe to run several copies: jobs
 * are claimed atomically and a claim expires, so two workers never take the same
 * job and a worker that dies does not strand one.
 *
 * ---------------------------------------------------------------------------
 * Deploying this
 * ---------------------------------------------------------------------------
 *
 * Three shapes, and the trade-off between them:
 *
 *   **Dedicated worker** — `npm run worker` as a long-running process, one or
 *   more replicas. Lowest latency (a job starts within the poll interval),
 *   simplest to reason about, and costs a process that is idle most of the time.
 *   This is the right default for a small SaaS.
 *
 *   **Cron-triggered** — `npm run worker -- --once` on a schedule, or a
 *   scheduled function hitting the same code. No idle process, so it suits a
 *   serverless platform, and latency is bounded by the cron interval rather than
 *   the poll. A minute is usually fine; anything needing seconds is not a fit.
 *
 *   **A queue provider** — SQS, QStash, Inngest. Adds real infrastructure and
 *   removes the polling, the claim TTL and the backoff, because the provider
 *   owns them. Worth it once jobs are numerous enough that polling the database
 *   is itself load; not before.
 *
 * The outbox stays the source of truth in all three: a job is durable because it
 * committed with the change that caused it, not because a queue accepted it.
 */
import { registerJobHandlers, handlerNames } from "@/lib/jobs/handlers";
import { queueDepth, runJobs, sweep, WORKER_ID } from "@/lib/jobs";
import { log } from "@/lib/logger";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2_000);
const IDLE_POLL_MS = Number(process.env.WORKER_IDLE_POLL_MS ?? 10_000);
const SWEEP_MS = Number(process.env.WORKER_SWEEP_MS ?? 15 * 60_000);
const BATCH = Number(process.env.WORKER_BATCH ?? 10);

const once = process.argv.includes("--once");

let running = true;
let lastSweep = 0;

async function drain(): Promise<number> {
  const result = await runJobs(BATCH);
  if (result.processed || result.failed || result.dead) {
    log.info("worker batch", result);
  }
  return result.processed + result.failed + result.dead;
}

async function maybeSweep(): Promise<void> {
  if (Date.now() - lastSweep < SWEEP_MS) return;
  lastSweep = Date.now();
  try {
    const removed = await sweep();
    // Flattened to a string: the log redactor blanks any key matching
    // /session|token/, which is right for a credential and unhelpful for a count.
    log.info("worker sweep", {
      detail: Object.entries(removed).map(([k, v]) => `${k}=${v}`).join(" "),
    });
  } catch (error) {
    // Maintenance failing must not stop the job loop.
    log.error("worker sweep failed", { error: String(error) });
  }
}

async function main() {
  registerJobHandlers();

  const depth = await queueDepth();
  console.log(
    `Tiny CRM worker ${WORKER_ID}\n` +
      `  handlers: ${handlerNames().length}\n` +
      `  queue:    ${depth.pending} pending, ${depth.failed} retrying, ${depth.dead} dead\n` +
      `  mode:     ${once ? "single pass" : `polling every ${POLL_MS}ms`}\n`,
  );

  if (depth.dead > 0) {
    console.warn(
      `  ${depth.dead} job(s) are dead-lettered and will not be retried automatically.\n` +
        `  Inspect them with listDeadJobs(), fix the cause, then replayDeadJob(id).\n`,
    );
  }

  if (once) {
    // Keep draining until the queue is empty, so a cron run is not limited to
    // one batch.
    let total = 0;
    for (;;) {
      const handled = await drain();
      total += handled;
      if (handled === 0) break;
    }
    await maybeSweep();
    console.log(`Handled ${total} job(s).`);
    return;
  }

  while (running) {
    const handled = await drain().catch((error) => {
      // A failure in the loop itself — not in a job — must not kill the worker.
      log.error("worker loop error", { error: String(error) });
      return 0;
    });
    await maybeSweep();
    // Back off when idle, so an empty queue is not a busy poll against the
    // database.
    await new Promise((resolve) => setTimeout(resolve, handled > 0 ? POLL_MS : IDLE_POLL_MS));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Finishes the batch in flight rather than abandoning claimed jobs; the
    // claim would expire anyway, but a clean stop avoids the wait.
    console.log(`\n${signal} — finishing the current batch, then stopping.`);
    running = false;
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    const { db } = await import("@/lib/db");
    await db.$disconnect();
  });
