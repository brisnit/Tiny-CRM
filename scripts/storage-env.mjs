#!/usr/bin/env node
/**
 * Supplies the object-storage environment the suites need.
 *
 * The same bargain scripts/pg.mjs strikes: if the dependency can be provided
 * locally, provide it and run the real tests; if it cannot, say so plainly and
 * let the affected suites skip rather than fail.
 *
 * Skipping is the right outcome rather than a failure because these suites test
 * a *driver against a real endpoint*. With no endpoint there is nothing to
 * assert, and a green run that silently asserted nothing would be worse than an
 * honest skip — which is why the suites announce the skip and why CI can choose
 * to require them.
 *
 * An operator who already has an S3-compatible endpoint can set S3_ENDPOINT
 * themselves; that always wins, and nothing is started.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Returns the variables to merge into the test environment, or `{}` when no
 * object store is available.
 */
export async function storageEnvFor() {
  // An externally supplied endpoint is used as-is. This is the path a developer
  // takes to run the same suites against a throwaway R2 bucket (Phase 1.5).
  if (process.env.S3_ENDPOINT) {
    console.log(`Using the object storage already configured at ${process.env.S3_ENDPOINT}.`);
    return {};
  }

  try {
    execFileSync("which", ["minio"], { stdio: "ignore" });
  } catch {
    console.warn(
      "\nMinIO is not installed, so the object-storage suites will skip.\n" +
        "  brew install minio\n" +
        "Or set S3_ENDPOINT to an S3-compatible endpoint you already have.\n",
    );
    return {};
  }

  try {
    execFileSync("node", ["scripts/minio.mjs", "start"], { cwd: ROOT, stdio: "inherit" });
    const printed = execFileSync("node", ["scripts/minio.mjs", "env"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    const vars = {};
    for (const line of printed.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) vars[match[1]] = match[2];
    }
    return vars;
  } catch (error) {
    console.warn(
      `\nCould not start MinIO (${error?.message ?? error}).\n` +
        "The object-storage suites will skip.\n",
    );
    return {};
  }
}
