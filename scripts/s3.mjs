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
 *   node scripts/s3.mjs start    # start, provision, and create the bucket
 *   node scripts/s3.mjs stop
 *   node scripts/s3.mjs env      # print the variables the suite needs
 *   node scripts/s3.mjs status
 *
 * Install once with `brew install garage`.
 *
 * ---------------------------------------------------------------------------
 * Why Garage, when this was MinIO
 * ---------------------------------------------------------------------------
 *
 * MinIO's open-source server was archived and every community binary
 * withdrawn: the download this file and the CI job used answers HTTP 410 with
 * "no longer served from this site", and Homebrew carries the formula as
 * deprecated with reason `repo_archived`. That took the Browser regressions job
 * down outright — which is the behaviour we asked for, since those suites were
 * made to fail rather than skip when CI has no storage.
 *
 * SeaweedFS was tried first and rejected on evidence. `weed server -s3` runs a
 * master/volume/filer cluster to reach an S3 endpoint, and its single-node raft
 * bootstrap is not deterministic: of three cold starts two never became ready,
 * and one measured run sat for 933 seconds before electing itself leader.
 * `-master.raftBootstrap` did not change it. A 15-minute stall in the job whose
 * whole purpose is to stop silent skips is worse than the problem.
 *
 * Garage is one process, starts in about a second, is maintained, and verifies
 * SigV4 for real — an unsigned request, a wrong secret and a presigned URL
 * whose key was edited are each refused, which a mock that ignores signatures
 * would not do.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { AwsClient } from "aws4fetch";

const ROOT = resolve(import.meta.dirname, "..");
const DATA = resolve(ROOT, ".s3data");
const CONFIG = resolve(DATA, "config.toml");
const META = resolve(DATA, "meta");
const BLOBS = resolve(DATA, "blobs");
const PIDFILE = resolve(DATA, "s3.pid");
const LOG = resolve(DATA, "storage.log");

// 9010 is kept from the MinIO era: it is what a developer already has in a
// local .env, and what tests/unit/csp-storage-origin names as the origin a
// local upload comes from. The other two are Garage's cluster RPC and its
// admin API, which only this script talks to.
const PORT = Number(process.env.S3_PORT ?? process.env.MINIO_PORT ?? 9010);
const RPC_PORT = Number(process.env.S3_RPC_PORT ?? 9015);
const ADMIN_PORT = Number(process.env.S3_ADMIN_PORT ?? 9016);

const ENDPOINT = `http://127.0.0.1:${PORT}`;

// Fixed, local-only, and never a production credential. Garage accepts an
// arbitrary access key id through `key import`, so these stay the values a
// developer may already have in .env rather than something generated per
// machine.
const ACCESS_KEY = "tinycrmlocal";
const SECRET_KEY = "tinycrmlocalsecret";
const BUCKET = process.env.STORAGE_BUCKET ?? "tiny-crm-documents-local";

// `auto` because that is what R2 wants in production, so the suites sign with
// the region they will sign with for real.
const REGION = "auto";

// Garage requires a shared secret for cluster RPC even with one node. There is
// nothing to protect: this instance listens on loopback and holds test
// fixtures under a credential committed to this file.
const RPC_SECRET = "0".repeat(63) + "1";

const client = (secret = SECRET_KEY) =>
  new AwsClient({ accessKeyId: ACCESS_KEY, secretAccessKey: secret, region: REGION, service: "s3" });

function garageBinary() {
  try {
    return execFileSync("which", ["garage"], { encoding: "utf8" }).trim();
  } catch {
    console.error(
      "Garage is not installed.\n\n" +
        "  brew install garage\n\n" +
        "Or point S3_ENDPOINT at any S3-compatible endpoint you already have.",
    );
    process.exit(2);
  }
}

/** Runs a `garage` subcommand against this instance. Never throws. */
function garage(args) {
  try {
    return {
      ok: true,
      out: execFileSync("garage", ["-c", CONFIG, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return { ok: false, out: `${error?.stdout ?? ""}${error?.stderr ?? ""}` };
  }
}

function writeConfig() {
  mkdirSync(META, { recursive: true });
  mkdirSync(BLOBS, { recursive: true });
  writeFileSync(
    CONFIG,
    [
      `metadata_dir = "${META}"`,
      `data_dir = "${BLOBS}"`,
      `db_engine = "lmdb"`,
      `replication_factor = 1`,
      `rpc_bind_addr = "127.0.0.1:${RPC_PORT}"`,
      `rpc_public_addr = "127.0.0.1:${RPC_PORT}"`,
      `rpc_secret = "${RPC_SECRET}"`,
      ``,
      `[s3_api]`,
      `s3_region = "${REGION}"`,
      `api_bind_addr = "127.0.0.1:${PORT}"`,
      // Path-style addressing is what the driver uses, so this is only here to
      // satisfy the config; no test resolves a bucket as a subdomain.
      `root_domain = ".s3.localhost"`,
      ``,
      `[admin]`,
      `api_bind_addr = "127.0.0.1:${ADMIN_PORT}"`,
      `admin_token = "local-admin-token"`,
      ``,
    ].join("\n"),
    "utf8",
  );
}

/**
 * Ready means "a signed request from our credentials lists our bucket".
 *
 * Nothing weaker will do, and Garage is the reason. Asked to bind a port that
 * is already held, it logs `S3 API server exited with error: Address already in
 * use` and *keeps running* — `garage status` answers happily from the admin
 * API while there is no S3 endpoint at all. A liveness probe that asked the
 * process whether it was up would have called that healthy.
 */
async function reachable(timeoutMs = 2000) {
  try {
    const response = await client().fetch(`${ENDPOINT}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    return (await response.text()).includes(`<Name>${BUCKET}</Name>`);
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`Timed out waiting for ${what}. See ${LOG}.`);
  return false;
}

/** True once the S3 port answers anything at all, which proves it bound. */
async function s3PortAnswers() {
  try {
    await fetch(`${ENDPOINT}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives the single node a storage role, creates the key and the bucket.
 *
 * Every step here is run unconditionally and its result ignored, because
 * `garage` reports "Error: ... already exists (409)" on a second run and still
 * exits 0 — so neither the exit code nor the absence of output distinguishes
 * "already done" from "failed". Nothing is concluded from these calls. What
 * decides whether `start` succeeded is `reachable()`, which signs a real
 * request and looks for the bucket.
 */
function provision() {
  const status = garage(["status"]).out;
  if (status.includes("NO ROLE ASSIGNED")) {
    const id = (garage(["node", "id", "-q"]).out || "").trim().split("@")[0];
    if (id) {
      garage(["layout", "assign", "-z", "local", "-c", "1G", id]);
      const shown = garage(["layout", "show"]).out;
      const current = Number(/Current cluster layout version:\s*(\d+)/.exec(shown)?.[1] ?? 0);
      garage(["layout", "apply", "--version", String(current + 1)]);
    }
  }
  garage(["key", "import", ACCESS_KEY, SECRET_KEY, "-n", "tinycrm", "--yes"]);
  garage(["bucket", "create", BUCKET]);
  garage(["bucket", "allow", "--read", "--write", "--owner", BUCKET, "--key", ACCESS_KEY]);
}

/**
 * A bucket CORS rule, because a direct-to-storage upload is a cross-origin PUT
 * and the browser preflights it.
 *
 * MinIO answered a preflight out of the box; Garage answers one only where a
 * rule says to. That makes the local store more like production rather than
 * less: on R2 the CORS rule is configuration too, which is what
 * tests/integration/storage.test.ts already says about this case.
 */
async function applyCors() {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CORSConfiguration><CORSRule>` +
    `<AllowedOrigin>*</AllowedOrigin>` +
    `<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>` +
    `<AllowedMethod>HEAD</AllowedMethod>` +
    `<AllowedHeader>*</AllowedHeader>` +
    `<ExposeHeader>ETag</ExposeHeader>` +
    `<MaxAgeSeconds>3000</MaxAgeSeconds>` +
    `</CORSRule></CORSConfiguration>`;
  const response = await client().fetch(`${ENDPOINT}/${BUCKET}?cors`, {
    method: "PUT",
    body: xml,
    headers: {
      "content-type": "application/xml",
      "content-md5": createHash("md5").update(xml).digest("base64"),
    },
  });
  if (!response.ok) {
    throw new Error(`Could not set the bucket CORS rule: ${response.status} ${await response.text()}`);
  }
}

async function start() {
  if (await reachable()) {
    console.log(`Object storage is already running on ${ENDPOINT}`);
    return;
  }

  garageBinary();
  mkdirSync(DATA, { recursive: true });
  writeConfig();

  const log = openSync(LOG, "a");
  const child = spawn("garage", ["-c", CONFIG, "server"], {
    cwd: ROOT,
    // Detached so the store outlives the script, the way pg.mjs leaves a
    // cluster running between test invocations.
    detached: true,
    // Kept rather than discarded, because a start that fails fails for a
    // reason worth reading — a port already held, most often.
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(PIDFILE, String(child.pid), "utf8");

  if (!(await waitFor(() => garage(["status"]).ok, 30_000, "the node to answer"))) process.exit(1);
  if (!(await waitFor(s3PortAnswers, 30_000, `the S3 API to bind ${PORT}`))) process.exit(1);

  provision();

  if (!(await waitFor(reachable, 30_000, `bucket "${BUCKET}" to be reachable`))) process.exit(1);
  await applyCors();

  console.log(`Object storage is running on ${ENDPOINT}, bucket "${BUCKET}".`);
}

/**
 * Stops, and does not return until the port is actually free.
 *
 * The earlier version sent SIGTERM and returned immediately. That is how a
 * verification run came to start a second server while the first still held
 * 9010: the new one could not bind, the old one was on its way out, and the
 * suites failed for a reason that had nothing to do with the code under test.
 */
async function stop() {
  if (!existsSync(PIDFILE)) {
    console.log("No object-storage process was started by this script.");
    return;
  }
  const pid = Number(readFileSync(PIDFILE, "utf8").trim());
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (!alive()) {
    console.log("Object storage was not running.");
    rmSync(PIDFILE, { force: true });
    return;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (alive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive()) {
    process.kill(pid, "SIGKILL");
    console.log(`Stopped object storage (pid ${pid}, had to be killed).`);
  } else {
    console.log(`Stopped object storage (pid ${pid}).`);
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
  console.log(
    [
      `STORAGE_DRIVER=local`,
      `STORAGE_BUCKET=${BUCKET}`,
      `S3_ENDPOINT=${ENDPOINT}`,
      `S3_REGION=${REGION}`,
      `S3_ACCESS_KEY_ID=${ACCESS_KEY}`,
      `S3_SECRET_ACCESS_KEY=${SECRET_KEY}`,
    ].join("\n"),
  );
}

const command = process.argv[2] ?? "start";

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
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
