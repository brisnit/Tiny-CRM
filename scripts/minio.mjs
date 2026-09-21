#!/usr/bin/env node
/**
 * A local S3-compatible object store, for exercising the real storage driver.
 *
 * The same idea as scripts/pg.mjs: a developer with no cloud account and no
 * Docker can still run the code production runs. `src/lib/storage.ts` has one
 * implementation, and `STORAGE_DRIVER=local` points it here instead of at
 * Cloudflare R2. So a local test signs a real SigV4 request, issues a real
 * presigned URL, performs a real PUT, a real HEAD, a real ranged GET and a real
 * DELETE — the operations that would otherwise be discovered to be wrong in
 * production.
 *
 *   node scripts/minio.mjs start    # start, and create the bucket
 *   node scripts/minio.mjs stop
 *   node scripts/minio.mjs env      # print the variables the suite needs
 *   node scripts/minio.mjs status
 *
 * Install once with `brew install minio`.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { AwsClient } from "aws4fetch";

const ROOT = resolve(import.meta.dirname, "..");
const DATA = resolve(ROOT, ".miniodata");
const PIDFILE = resolve(DATA, "minio.pid");

// Deliberately not 9000: that is MinIO's default and the port a developer is
// most likely to already have something on.
const PORT = Number(process.env.MINIO_PORT ?? 9010);
const CONSOLE_PORT = Number(process.env.MINIO_CONSOLE_PORT ?? 9011);
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// Fixed, local-only, and never a production credential. MinIO requires at least
// three characters for the user and eight for the password.
const ACCESS_KEY = "tinycrmlocal";
const SECRET_KEY = "tinycrmlocalsecret";
const BUCKET = process.env.STORAGE_BUCKET ?? "tiny-crm-documents-local";
const REGION = "auto";

const client = () =>
  new AwsClient({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: REGION,
    service: "s3",
  });

function minioBinary() {
  try {
    return execFileSync("which", ["minio"], { encoding: "utf8" }).trim();
  } catch {
    console.error(
      "MinIO is not installed.\n\n" +
        "  brew install minio\n\n" +
        "Or point S3_ENDPOINT at any S3-compatible endpoint you already have.",
    );
    process.exit(2);
  }
}

async function reachable() {
  try {
    const response = await fetch(`${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilReachable(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Creates the bucket. Already existing is success, not an error. */
async function ensureBucket() {
  const response = await client().fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
  if (response.ok || response.status === 409) return;
  const body = await response.text();
  // MinIO answers an existing bucket with BucketAlreadyOwnedByYou.
  if (body.includes("BucketAlreadyOwnedByYou") || body.includes("BucketAlreadyExists")) return;
  throw new Error(`Could not create the bucket: ${response.status} ${body}`);
}

async function start() {
  if (await reachable()) {
    await ensureBucket();
    console.log(`MinIO is already running on ${ENDPOINT}`);
    return;
  }

  const binary = minioBinary();
  mkdirSync(DATA, { recursive: true });

  const child = spawn(
    binary,
    [
      "server",
      DATA,
      "--address", `:${PORT}`,
      "--console-address", `:${CONSOLE_PORT}`,
    ],
    {
      cwd: ROOT,
      // Detached so the store outlives the script, the way pg.mjs leaves a
      // cluster running between test invocations.
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        MINIO_ROOT_USER: ACCESS_KEY,
        MINIO_ROOT_PASSWORD: SECRET_KEY,
        // Silences the update banner on a throwaway instance.
        MINIO_UPDATE: "off",
      },
    },
  );
  child.unref();
  writeFileSync(PIDFILE, String(child.pid), "utf8");

  if (!(await waitUntilReachable())) {
    console.error(`MinIO did not become reachable on ${ENDPOINT}.`);
    process.exit(1);
  }

  await ensureBucket();
  console.log(`MinIO is running on ${ENDPOINT}, bucket "${BUCKET}".`);
}

function stop() {
  if (!existsSync(PIDFILE)) {
    console.log("No MinIO process was started by this script.");
    return;
  }
  const pid = Number(readFileSync(PIDFILE, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped MinIO (pid ${pid}).`);
  } catch {
    console.log("MinIO was not running.");
  }
  rmSync(PIDFILE, { force: true });
}

/**
 * The environment the suite needs.
 *
 * `STORAGE_DRIVER=local` rather than `s3` only to record the intent; both
 * select the same driver, which is the point of having one.
 */
function printEnv() {
  const lines = [
    `STORAGE_DRIVER=local`,
    `STORAGE_BUCKET=${BUCKET}`,
    `S3_ENDPOINT=${ENDPOINT}`,
    `S3_REGION=${REGION}`,
    `S3_ACCESS_KEY_ID=${ACCESS_KEY}`,
    `S3_SECRET_ACCESS_KEY=${SECRET_KEY}`,
  ];
  console.log(lines.join("\n"));
}

const command = process.argv[2] ?? "start";

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "env":
    printEnv();
    break;
  case "status":
    console.log((await reachable()) ? `running on ${ENDPOINT}` : "not running");
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(2);
}
