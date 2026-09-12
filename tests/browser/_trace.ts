import { chromium, type Browser, type LaunchOptions } from "playwright";

/**
 * Temporary checkpoint tracing for the browser *runner*, for one investigation.
 *
 * The round before this one proved the invite route is not the problem: it
 * entered application code and completed every checkpoint in 127ms. What the
 * server log then showed was nothing at all — no HTTP request from any suite,
 * including the ones that were passing before. So the browser test process
 * fails somewhere between being spawned and issuing its first request, and the
 * server cannot see that part.
 *
 * These marks come from inside the test process. The harness captures its
 * output now instead of inheriting it, so the last checkpoint survives into a
 * GitHub annotation — the only failure channel readable on this repository
 * without admin access to CI logs.
 *
 * Written to stderr rather than stdout: node:test owns stdout for its reporter
 * and may buffer or reorder what a test file writes there, and a checkpoint
 * that arrives out of order is worse than none.
 *
 * Nothing here prints a value. Steps and durations only.
 *
 * Delete this file and its call sites once the cause is established.
 */

const started = Date.now();

export function runnerMark(step: string, meta?: Record<string, string | number | boolean>): void {
  const extra = meta ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`RUNNER ${step} +${Date.now() - started}ms${extra}\n`);
}

/**
 * `chromium.launch()` with the attempt and the outcome both recorded.
 *
 * Launching is the step most likely to fail silently in CI — a missing shared
 * library or a sandbox refusal produces a process that never answers rather
 * than an exception anyone sees — and it is the one step every browser suite
 * performs before it can do anything else.
 */
export async function tracedLaunch(label: string, options?: LaunchOptions): Promise<Browser> {
  runnerMark(`chromium:launch:start`, { suite: label });
  try {
    const browser = await chromium.launch(options);
    runnerMark(`chromium:launch:end`, { suite: label, version: browser.version() });
    return browser;
  } catch (error) {
    runnerMark(`chromium:launch:failed`, {
      suite: label,
      error: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
}

/** Records that a file was imported at all — the earliest signal there is. */
export function markImported(file: string): void {
  runnerMark("file:imported", { file });
}
