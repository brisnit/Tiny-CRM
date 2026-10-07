import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { utimes, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { scanForMalware } from "../../src/lib/malware";

/**
 * Real ClamAV, when there is one.
 *
 * Every other scanning suite stands in for detection: the gateway contract test
 * uses a fake `clamd`, and the upload end-to-end test tells its gateway what to
 * find. Both are correct about *our* behaviour and neither establishes that
 * ClamAV scans anything. This one does, and skips when no local `clamd` is
 * listening — the same bargain the object-storage suites strike with MinIO,
 * because a green run that silently asserted nothing would be worse than an
 * honest skip.
 *
 * To make it run:
 *
 *   brew install clamav
 *   # configure DatabaseDirectory + TCPSocket 3310 + TCPAddr 127.0.0.1
 *   freshclam --config-file=<your freshclam.conf>
 *   clamd --config-file=<your clamd.conf>
 *   CLAMD_PORT=3310 CLAMAV_DB_DIR=<db dir> npm test
 *
 * ## The finding this suite exists to pin down
 *
 * **ClamAV does not detect EICAR behind a `%PDF-1.4` header.** Byte-identical
 * signature, `OK` instead of `FOUND`, because the header changes the file's type
 * and ClamAV parses it as a PDF rather than scanning it as plain data. Measured
 * against 1.5.4 with the full signature set, through `clamdscan` as well as the
 * gateway.
 *
 * That matters because the obvious liveness check — wrap EICAR in a PDF, upload
 * it, see it blocked — reports `OK` from a perfectly healthy scanner. The
 * documented check therefore uses pure EICAR, and both forms are asserted below
 * so that the distinction cannot quietly stop being true.
 */

const CLAMD_HOST = process.env.CLAMD_HOST ?? "127.0.0.1";
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? 3310);
const DB_DIR = process.env.CLAMAV_DB_DIR ?? "";
const GATEWAY = resolve(process.cwd(), "deploy/clamav-gateway/server.mjs");
const TOKEN = "real-clamav-suite-token";

/** The EICAR test string, assembled so this file is not itself flagged. */
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR",
  "-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
].join("");

const PURE = new Uint8Array(Buffer.from(EICAR, "latin1"));
const PDF_WRAPPED = new Uint8Array(
  Buffer.concat([Buffer.from("%PDF-1.4\n% ", "latin1"), Buffer.from(EICAR, "latin1")]),
);
const CLEAN = new Uint8Array(Buffer.from("%PDF-1.4\nnothing to see here\n", "latin1"));

/**
 * Is a clamd listening and answering PING?
 *
 * **Synchronous, deliberately.** `test(name, options, fn)` evaluates its
 * options when the `describe` body runs, which is before any hook — so a flag
 * set inside `before` is still false by the time every skip decision has been
 * made, and the whole suite skipped silently on a machine with clamd running.
 * Top-level await would fix the ordering but this runner compiles to CJS and
 * rejects it, so the probe runs in a child process and blocks.
 */
function clamdAliveSync(): boolean {
  const probe = `
    const { connect } = require("node:net");
    const s = connect(${CLAMD_PORT}, ${JSON.stringify(CLAMD_HOST)});
    let reply = "";
    const done = (ok) => { s.destroy(); process.exit(ok ? 0 : 1); };
    s.setTimeout(3000, () => done(false));
    s.on("error", () => done(false));
    s.on("connect", () => s.write("zPING\\0"));
    s.on("data", (d) => { reply += d.toString(); if (reply.includes("PONG")) done(true); });
    s.on("close", () => done(reply.includes("PONG")));
  `;
  try {
    execFileSync(process.execPath, ["-e", probe], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probed at module load, not in `before`.
 *
 * `test(name, options, fn)` evaluates its options when the `describe` body
 * runs, which is *before* any hook — so a flag set inside `before` is still
 * false by the time every skip decision has been made, and the whole suite
 * skipped silently on a machine with clamd running. Top-level await is the fix
 * because it completes before the describes are registered.
 */
const available = clamdAliveSync();
if (!available) {
  console.log(`  (real ClamAV suite skipped: no clamd answering on ${CLAMD_HOST}:${CLAMD_PORT})`);
}

let gateway: ChildProcess | null = null;
let base = "";
const saved: Record<string, string | undefined> = {};

before(async () => {
  if (!available) return;

  gateway = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      PORT: "0",
      SCANNER_TOKEN: TOKEN,
      CLAMD_HOST,
      CLAMD_PORT: String(CLAMD_PORT),
      ...(DB_DIR ? { CLAMAV_DB_DIR: DB_DIR } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("the gateway did not announce a port")), 15_000);
    gateway!.stdout!.on("data", (d: Buffer) => {
      const m = /listening on (\d+)/.exec(d.toString());
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    gateway!.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the gateway exited ${code}`));
    });
  });
  base = `http://127.0.0.1:${port}`;

  for (const key of ["MALWARE_SCANNER_URL", "MALWARE_SCANNER_TOKEN", "REQUIRE_MALWARE_SCAN"]) {
    saved[key] = process.env[key];
  }
  process.env.MALWARE_SCANNER_URL = `${base}/scan`;
  process.env.MALWARE_SCANNER_TOKEN = TOKEN;
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  gateway?.kill("SIGKILL");
});

/** Skips the whole suite when there is no scanner to ask. */
function needsClamd() {
  return available ? undefined : { skip: "no local clamd" };
}

describe("real ClamAV, through the real gateway and adapter", () => {
  test("a clean file is clean", needsClamd(), async () => {
    const verdict = await scanForMalware(CLEAN, { key: "k" });
    assert.equal(verdict.status, "clean");
  });

  test("pure EICAR is detected, and names ClamAV's own signature", needsClamd(), async () => {
    const verdict = await scanForMalware(PURE, { key: "k" });
    assert.equal(verdict.status, "infected", "real ClamAV did not detect the EICAR test file");
    if (verdict.status === "infected") {
      assert.match(
        verdict.signature,
        /eicar/i,
        `the signature came through as ${JSON.stringify(verdict.signature)}`,
      );
    }
  });

  test("EICAR behind a PDF header is NOT detected", needsClamd(), async () => {
    /**
     * Asserting the limitation, not working around it.
     *
     * If this ever starts failing, ClamAV has changed how it types or parses
     * these files — which would be good news, and would mean the documented
     * liveness check can be simplified. Until then the check must use pure
     * EICAR, and an upload of a PDF-wrapped one being accepted is **not**
     * evidence that scanning is broken.
     */
    const verdict = await scanForMalware(PDF_WRAPPED, { key: "k" });
    assert.equal(
      verdict.status,
      "clean",
      "ClamAV now detects PDF-wrapped EICAR — update docs/MALWARE-SCANNING.md section 7, " +
        "which tells an operator to expect OK here",
    );
  });

  test("the whole corpus of signatures is loaded, not an empty database", needsClamd(), async () => {
    // A clamd with no signatures answers OK to everything, which is the most
    // dangerous healthy-looking state there is. Detection of EICAR above is the
    // real proof; this checks the database is substantial rather than a stub.
    if (!DB_DIR) return;
    const names = await readdir(DB_DIR);
    assert.ok(
      names.some((n) => /^main\.(cvd|cld)$/.test(n)),
      `no main database in ${DB_DIR} — found ${names.join(", ")}`,
    );
  });
});

describe("staleness and outage, against real ClamAV", () => {
  test("backdated signatures refuse scans rather than reporting clean", needsClamd(), async () => {
    if (!DB_DIR) return;
    const files = (await readdir(DB_DIR)).filter((n) => /\.(cvd|cld)$/.test(n));
    assert.ok(files.length > 0, "no signature files to backdate");
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    try {
      for (const name of files) await utimes(join(DB_DIR, name), old, old);
      await assert.rejects(
        () => scanForMalware(CLEAN, { key: "k" }),
        /could not scan/i,
        "a 30-day-old signature database still produced verdicts",
      );
      // And EICAR too: stale means no answers at all, not "answers for the
      // things we happen to still recognise".
      await assert.rejects(() => scanForMalware(PURE, { key: "k" }), /could not scan/i);
    } finally {
      const now = new Date();
      for (const name of files) await utimes(join(DB_DIR, name), now, now);
    }
  });

  test("and scanning resumes once they are fresh", needsClamd(), async () => {
    const verdict = await scanForMalware(PURE, { key: "k" });
    assert.equal(verdict.status, "infected", "the staleness check did not clear");
  });
});
