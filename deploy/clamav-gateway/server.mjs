#!/usr/bin/env node
/**
 * An HTTP front door for `clamd`, speaking exactly what Tiny CRM's adapter reads.
 *
 * `src/lib/malware.ts` accepts two reply shapes and refuses everything else, so
 * this returns one of exactly two bodies:
 *
 *   {"Status":"OK"}                                       -> clean
 *   {"Status":"FOUND","Description":"Eicar-Signature"}    -> infected
 *
 * Any other status, a non-JSON body, or a non-200 is treated by the adapter as
 * "no verdict" and the upload is refused. That is deliberate on both sides:
 * there is no third value either end can mistake for good news.
 *
 * No dependencies. `clamd` is reached over its INSTREAM protocol on loopback,
 * so the daemon is never exposed and nothing is written to disk.
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { readdir, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const CLAMD_HOST = process.env.CLAMD_HOST ?? "127.0.0.1";
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? 3310);
const TOKEN = process.env.SCANNER_TOKEN ?? "";
/** Must not exceed the app's own upload ceiling. */
const MAX_BYTES = Number(process.env.MAX_SCAN_BYTES ?? 25 * 1024 * 1024);
/** INSTREAM requires chunks below clamd's StreamMaxLength; 64 KiB is safe. */
const CHUNK = 64 * 1024;
/** Beyond this, the signature database is too old to answer with. */
const MAX_SIGNATURE_AGE_HOURS = Number(process.env.MAX_SIGNATURE_AGE_HOURS ?? 48);
const SIGNATURE_DIR = process.env.CLAMAV_DB_DIR ?? "/var/lib/clamav";

if (!TOKEN) {
  console.error("SCANNER_TOKEN is not set. Refusing to start: an unauthenticated scanner is an open relay for anyone's files.");
  process.exit(1);
}

/** Constant-time, and length-safe — `timingSafeEqual` throws on a mismatch. */
function authorised(header) {
  const presented = Buffer.from(String(header ?? "").replace(/^Bearer\s+/i, ""), "utf8");
  const expected = Buffer.from(TOKEN, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Can clamd actually answer?
 *
 * Added after deploying. On a machine restart the gateway was answering
 * `/live` and `/health` with 200 while clamd was still loading the signature
 * set from the volume — so Fly routed traffic to a scanner that returned 502
 * for about ten seconds. Fail-closed, so uploads refused rather than passing
 * unscanned, but an avoidable outage window and a health endpoint that was
 * lying.
 *
 * `/live` now depends on this, so the platform withholds traffic until the
 * scanner can scan. Signature *freshness* deliberately stays out of `/live`:
 * restarting a machine does not make signatures fresher, and tying the two
 * together would loop. Staleness is enforced at scan time.
 */
function ping(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = connect(CLAMD_PORT, CLAMD_HOST);
    let reply = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (d) => {
      reply += d.toString("utf8");
      if (reply.includes("PONG")) finish(true);
    });
    socket.on("close", () => finish(reply.includes("PONG")));
  });
}

/** Streams a buffer to clamd and returns its one-line reply. */
function scan(bytes) {
  return new Promise((resolve, reject) => {
    const socket = connect(CLAMD_PORT, CLAMD_HOST);
    let reply = "";
    socket.setTimeout(30_000, () => socket.destroy(new Error("clamd timed out")));
    socket.on("error", reject);
    socket.on("data", (d) => { reply += d.toString("utf8"); });
    // `z`-prefixed commands get a NUL-terminated reply, and NUL is not
    // whitespace — `.trim()` leaves it in place, so `stream: OK\0` does not
    // match /OK$/ and every clean file came back as "no verdict". Caught by
    // tests/security/clamav-gateway-contract.test.ts; it would have failed the
    // same way against real clamd.
    socket.on("end", () => resolve(reply.replace(/\0+$/, "").trim()));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let at = 0; at < bytes.length; at += CHUNK) {
        const slice = bytes.subarray(at, Math.min(at + CHUNK, bytes.length));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(slice.length, 0);
        socket.write(size);
        socket.write(slice);
      }
      socket.write(Buffer.from([0, 0, 0, 0])); // zero-length chunk ends the stream
    });
  });
}

/** Hours since the newest signature file was written. */
async function signatureAgeHours() {
  const names = await readdir(SIGNATURE_DIR);
  const relevant = names.filter((n) => /\.(cvd|cld)$/.test(n));
  if (relevant.length === 0) return Number.POSITIVE_INFINITY;
  const times = await Promise.all(
    relevant.map(async (n) => (await stat(join(SIGNATURE_DIR, n))).mtimeMs),
  );
  return (Date.now() - Math.max(...times)) / 3_600_000;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  /**
   * Liveness, unauthenticated, and deliberately uninformative.
   *
   * The platform's own health check cannot carry a credential: `fly.toml` is
   * committed, and there is no secret interpolation for check headers, so an
   * authenticated check would mean a token in version control.
   *
   * It reports only that the process is answering. **Not** signature freshness:
   * a failing platform check makes Fly restart the machine, and a restart does
   * not make signatures fresher — it would produce a restart loop while uploads
   * were already correctly refusing. Staleness is enforced where it belongs, at
   * scan time, and reported on the authenticated /health for an operator.
   */
  if (req.method === "GET" && url.pathname === "/live") {
    // 503 until clamd answers, so the platform does not route scans at a
    // scanner that cannot perform one. Still reveals nothing but liveness.
    const up = await ping();
    return send(res, up ? 200 : 503, { ok: up });
  }

  if (!authorised(req.headers.authorization)) {
    // No detail: an unauthenticated caller learns nothing about what runs here.
    return send(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    try {
      const [age, clamdUp] = await Promise.all([signatureAgeHours(), ping()]);
      const stale = age > MAX_SIGNATURE_AGE_HOURS;
      if (!clamdUp) {
        // Reported honestly rather than as "ok with a fresh database", which is
        // what this said during the restart window before deploying showed it.
        return send(res, 503, {
          status: "clamd unreachable",
          signatureAgeHours: Number.isFinite(age) ? Math.round(age) : null,
        });
      }
      // 503 rather than a verdict: the adapter throws on a non-200, so stale
      // signatures stop uploads exactly as an outage does. A scanner running a
      // six-month-old database reporting "clean" with authority is the failure
      // this exists to prevent.
      return send(res, stale ? 503 : 200, {
        status: stale ? "stale" : "ok",
        signatureAgeHours: Number.isFinite(age) ? Math.round(age) : null,
        maxSignatureAgeHours: MAX_SIGNATURE_AGE_HOURS,
      });
    } catch (error) {
      return send(res, 503, { status: "unknown", error: String(error?.message ?? error) });
    }
  }

  if (req.method !== "POST" || url.pathname !== "/scan") {
    return send(res, 404, { error: "not found" });
  }

  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on("data", (c) => {
    total += c.length;
    if (total > MAX_BYTES) {
      aborted = true;
      send(res, 413, { error: "too large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (aborted) return;
    try {
      // Refuse rather than report clean if the signatures are too old.
      if ((await signatureAgeHours()) > MAX_SIGNATURE_AGE_HOURS) {
        return send(res, 503, { error: "signature database is stale" });
      }
      const reply = await scan(Buffer.concat(chunks));
      // clamd answers "stream: OK" or "stream: <Signature> FOUND".
      if (/\bOK$/.test(reply)) return send(res, 200, { Status: "OK" });
      const found = /^stream:\s*(.+?)\s+FOUND$/.exec(reply);
      if (found) return send(res, 200, { Status: "FOUND", Description: found[1] });
      // An error line, or anything unrecognised. Not a verdict.
      return send(res, 502, { error: "clamd did not return a verdict" });
    } catch (error) {
      return send(res, 502, { error: String(error?.message ?? error) });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  // The *bound* port, not the configured one. With PORT=0 the OS chooses, and
  // logging the configured value would print "listening on 0" — which is how
  // the contract test first failed to find it.
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : PORT;
  console.log(`clamav gateway listening on ${bound}; clamd at ${CLAMD_HOST}:${CLAMD_PORT}`);
});
