/**
 * Temporary checkpoint tracing for one investigation.
 *
 * The browser CI job fails while every other job passes, and the dev server's
 * log shows three routes completing and then `/invite/[token]` producing no
 * completion line at all. Next logs a request when it finishes, so an absent
 * line means a request that never finished — but it cannot say whether the
 * route never compiled, or compiled and then hung, or hung inside a particular
 * await.
 *
 * These marks answer that. They go to stdout, which the browser harness already
 * captures and reports as a GitHub annotation, so the last checkpoint reached
 * survives into somewhere readable without admin access to CI logs.
 *
 * ---------------------------------------------------------------------------
 * Rules, because this prints from a server
 * ---------------------------------------------------------------------------
 *
 *  - **Off unless `BROWSER_DIAG=1`.** The harness sets it for the dev server it
 *    starts. Nothing else does, and production never will.
 *  - **No values, only shapes.** Booleans, counts, durations, engine names and
 *    the fixed failure reasons. Never a token, an address, a name, an id, a
 *    cookie or a connection string. Callers pass metadata; this module cannot
 *    police it, so the call sites are written to pass nothing that identifies
 *    anybody.
 *
 * Delete this module and its call sites once the cause is established.
 */

const ENABLED = process.env.BROWSER_DIAG === "1";

export type DiagMeta = Record<string, string | number | boolean | null>;

export type DiagTimer = {
  mark: (step: string, meta?: DiagMeta) => void;
};

/**
 * A named sequence of checkpoints, each with the time since the sequence began.
 *
 * The elapsed figure is what separates "slow" from "stopped": a checkpoint at
 * +40000ms is a slow await, and a missing checkpoint is an await that never
 * returned.
 */
export function diagTimer(scope: string): DiagTimer {
  if (!ENABLED) return { mark: () => {} };
  const started = Date.now();
  return {
    mark(step, meta) {
      const extra = meta ? ` ${JSON.stringify(meta)}` : "";
      // One line, prefixed, so the harness can pick these out of the server log.
      console.log(`DIAG ${scope} ${step} +${Date.now() - started}ms${extra}`);
    },
  };
}

/** Whether tracing is on, for call sites that would otherwise do work to build metadata. */
export const diagEnabled = ENABLED;
