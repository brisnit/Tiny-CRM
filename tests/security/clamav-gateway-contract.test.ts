import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { scanForMalware } from "../../src/lib/malware";

/**
 * The deployable gateway, driven by the real adapter.
 *
 * `deploy/clamav-gateway/server.mjs` is the thing that would run in production
 * and `src/lib/malware.ts` is what would call it. Each has been tested against
 * a stand-in for the other, which proves neither of them agrees with anything
 * real. This runs **both**: the actual gateway process, pointed at a fake
 * `clamd` speaking the INSTREAM protocol, called through the actual adapter.
 *
 * It is the one test that would catch the gateway and the adapter drifting
 * apart — a renamed field, a changed status string, an HTTP code moved from 200
 * to 202 — which is a failure that would present in production as every upload
 * being refused, or far worse, as every upload being accepted.
 *
 * The fake `clamd` is not pretending to detect anything. It replies with the
 * exact wire format `clamd` uses (`stream: OK` / `stream: <sig> FOUND` /
 * `ERROR`) and lets each test choose which. ClamAV's own detection is verified
 * against the deployed gateway with EICAR, per docs/MALWARE-SCANNING.md §7.2.
 */

const GATEWAY = resolve(process.cwd(), "deploy/clamav-gateway/server.mjs");
const TOKEN = "a-token-only-this-test-knows";

let clamd: TcpServer | null = null;
let gateway: ChildProcess | null = null;
let gatewayUrl = "";
let dbDir = "";
/** What the fake clamd replies with, chosen per test. */
let clamdReply: string | "hang" | "refuse" = "stream: OK";
let streamedBytes = 0;

const saved: Record<string, string | undefined> = {};

/**
 * A fake clamd: reads an INSTREAM body, then answers.
 *
 * It replies when it sees the **zero-length terminating chunk**, not when the
 * socket half-closes. That distinction is the protocol: real clamd answers on
 * the terminator and the client keeps the connection open to read the reply.
 *
 * The first version of this waited for `end`, which the gateway never sends —
 * so every successful scan sat until the adapter's 20-second timeout. Two
 * refusal tests "passed" through that timeout rather than because the gateway
 * returned 502, which is a false pass of exactly the kind this suite exists to
 * catch.
 */
async function startClamd(): Promise<number> {
  clamd = createTcpServer((socket) => {
    if (clamdReply === "refuse") { socket.destroy(); return; }
    let seen = 0;
    let tail = Buffer.alloc(0);
    let answered = false;
    socket.on("data", (chunk) => {
      // PING is its own command and answers immediately — the readiness check
      // in the gateway uses it, and a fake that only understood INSTREAM made
      // every /live call sit until the 4-second timeout.
      if (!answered && chunk.toString("latin1").startsWith("zPING")) {
        answered = true;
        socket.end("PONG\0");
        return;
      }
      seen += chunk.length;
      // The terminator is four zero bytes; it may straddle two reads.
      tail = Buffer.concat([tail, chunk]).subarray(-4);
      if (answered || tail.length < 4 || !tail.equals(Buffer.alloc(4))) return;
      answered = true;
      streamedBytes = seen;
      if (clamdReply === "hang") return; // never answers
      socket.end(`${clamdReply}\0`);
    });
    socket.on("error", () => { /* the gateway closing is not an error here */ });
  });
  await new Promise<void>((r) => clamd!.listen(0, "127.0.0.1", r));
  const address = clamd.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return address.port;
}

async function waitForGateway(url: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.status === 200 || r.status === 503) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the gateway did not start");
}

before(async () => {
  const clamdPort = await startClamd();

  // A signature directory with a fresh file, so /health is not stale.
  dbDir = await mkdtemp(join(tmpdir(), "clamav-db-"));
  await writeFile(join(dbDir, "daily.cvd"), "not a real database");
  const now = new Date();
  await utimes(join(dbDir, "daily.cvd"), now, now);

  gateway = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      PORT: "0",
      SCANNER_TOKEN: TOKEN,
      CLAMD_HOST: "127.0.0.1",
      CLAMD_PORT: String(clamdPort),
      CLAMAV_DB_DIR: dbDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The gateway prints the port it bound. PORT=0 means the OS chooses.
  const port = await new Promise<number>((resolveport, reject) => {
    const timer = setTimeout(() => reject(new Error("no port announced")), 15_000);
    gateway!.stdout!.on("data", (d: Buffer) => {
      const m = /listening on (\d+)/.exec(d.toString());
      if (m) { clearTimeout(timer); resolveport(Number(m[1])); }
    });
    gateway!.on("exit", (code) => { clearTimeout(timer); reject(new Error(`gateway exited ${code}`)); });
  });

  gatewayUrl = `http://127.0.0.1:${port}/scan`;
  await waitForGateway(`http://127.0.0.1:${port}/health`);

  for (const key of ["MALWARE_SCANNER_URL", "MALWARE_SCANNER_TOKEN", "REQUIRE_MALWARE_SCAN"]) {
    saved[key] = process.env[key];
  }
  process.env.MALWARE_SCANNER_URL = gatewayUrl;
  process.env.MALWARE_SCANNER_TOKEN = TOKEN;
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  gateway?.kill("SIGKILL");
  if (clamd) await new Promise<void>((r) => clamd!.close(() => r()));
});

beforeEach(() => {
  clamdReply = "stream: OK";
  streamedBytes = 0;
});

const BYTES = new Uint8Array(Buffer.from("%PDF-1.4\nsome content\n", "latin1"));

describe("the gateway and the adapter agree", () => {
  test("clamd OK reaches the adapter as clean", async () => {
    clamdReply = "stream: OK";
    // Asked directly first, so a failure says what the gateway actually replied
    // rather than only that the adapter refused it.
    const direct = await fetch(gatewayUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(BYTES),
    });
    assert.equal(direct.status, 200, `gateway replied ${direct.status}: ${await direct.text()}`);
    const verdict = await scanForMalware(BYTES, { key: "k" });
    assert.equal(verdict.status, "clean");
  });

  test("clamd FOUND reaches the adapter as infected, with the signature intact", async () => {
    clamdReply = "stream: Eicar-Test-Signature FOUND";
    const verdict = await scanForMalware(BYTES, { key: "k" });
    assert.equal(verdict.status, "infected");
    if (verdict.status === "infected") {
      assert.equal(
        verdict.signature,
        "Eicar-Test-Signature",
        "the signature name was mangled between clamd and the adapter",
      );
    }
  });

  test("a multi-word signature name survives", async () => {
    // clamd names can contain dots, dashes and spaces. The gateway's regex has
    // to capture the whole name and stop at FOUND.
    clamdReply = "stream: Win.Test.EICAR_HDB-1 FOUND";
    const verdict = await scanForMalware(BYTES, { key: "k" });
    assert.equal(verdict.status, "infected");
    if (verdict.status === "infected") assert.equal(verdict.signature, "Win.Test.EICAR_HDB-1");
  });

  test("the whole body reaches clamd, byte for byte", async () => {
    const big = new Uint8Array(Buffer.alloc(200_000, 0x41));
    big.set(Buffer.from("%PDF-1.4\n", "latin1"), 0);
    await scanForMalware(big, { key: "k" });
    // Everything clamd reads on the wire, accounted for exactly: the
    // `zINSTREAM\0` command, then each chunk framed with a 4-byte big-endian
    // length, then a zero-length chunk to terminate. Asserting the total rather
    // than "roughly the payload" is what makes a wrong chunk size or a dropped
    // frame visible — both of which truncate silently.
    const COMMAND = "zINSTREAM\0".length; // 10
    const chunks = Math.ceil(big.byteLength / (64 * 1024));
    assert.equal(
      streamedBytes,
      COMMAND + big.byteLength + chunks * 4 + 4,
      "the body clamd received is not the body we sent",
    );
  });
});

describe("the gateway refuses rather than guessing", () => {
  test("a clamd error line is not a verdict", async () => {
    clamdReply = "ERROR: size limit exceeded";
    await assert.rejects(
      () => scanForMalware(BYTES, { key: "k" }),
      /could not scan/i,
      "a clamd error was reported to the application as a clean file",
    );
  });

  test("an unrecognised clamd reply is not a verdict", async () => {
    clamdReply = "stream: something unexpected";
    await assert.rejects(() => scanForMalware(BYTES, { key: "k" }), /could not scan/i);
  });

  test("clamd refusing the connection is not a verdict", async () => {
    clamdReply = "refuse";
    await assert.rejects(() => scanForMalware(BYTES, { key: "k" }), /could not scan/i);
  });

  test("the wrong token is refused, and the adapter treats 401 as no verdict", async () => {
    const token = process.env.MALWARE_SCANNER_TOKEN;
    process.env.MALWARE_SCANNER_TOKEN = "not-the-token";
    try {
      await assert.rejects(
        () => scanForMalware(BYTES, { key: "k" }),
        /could not scan/i,
        "an unauthenticated scan was treated as a result",
      );
    } finally {
      process.env.MALWARE_SCANNER_TOKEN = token;
    }
  });

  test("no token at all is refused", async () => {
    const token = process.env.MALWARE_SCANNER_TOKEN;
    delete process.env.MALWARE_SCANNER_TOKEN;
    try {
      await assert.rejects(() => scanForMalware(BYTES, { key: "k" }), /could not scan/i);
    } finally {
      process.env.MALWARE_SCANNER_TOKEN = token;
    }
  });
});

describe("stale signatures fail closed", () => {
  test("a signature database older than the ceiling refuses scans", async () => {
    // The failure this prevents: a scanner running a six-month-old database,
    // answering "clean" with complete authority.
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    await utimes(join(dbDir, "daily.cvd"), old, old);
    try {
      await assert.rejects(
        () => scanForMalware(BYTES, { key: "k" }),
        /could not scan/i,
        "a stale signature database still produced verdicts",
      );
    } finally {
      const now = new Date();
      await utimes(join(dbDir, "daily.cvd"), now, now);
    }
  });

  test("and scanning resumes once they are fresh again", async () => {
    const verdict = await scanForMalware(BYTES, { key: "k" });
    assert.equal(verdict.status, "clean", "the staleness check did not clear");
  });
});

describe("liveness is unauthenticated and says nothing else", () => {
  test("/live answers without a token", async () => {
    // The platform's health check cannot carry a credential: fly.toml is
    // committed and has no secret interpolation for check headers. So /live is
    // open by necessity, and must therefore be worth nothing to a stranger.
    const response = await fetch(`${gatewayUrl.replace("/scan", "")}/live`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { ok: true }, "the open endpoint reveals more than liveness");
  });

  test("/live is 503 when clamd cannot answer", async () => {
    /**
     * Found by deploying, not by reasoning. On a machine restart the gateway
     * answered /live and /health with 200 while clamd was still loading the
     * signature set from the volume, so Fly routed traffic to a scanner that
     * returned 502 for about ten seconds — fail-closed, but an avoidable
     * outage window and a health endpoint that was lying.
     */
    clamdReply = "refuse";
    const live = await fetch(`${gatewayUrl.replace("/scan", "")}/live`);
    assert.equal(live.status, 503, "/live claimed healthy with clamd unreachable");
    assert.deepEqual(await live.json(), { ok: false });

    const health = await fetch(`${gatewayUrl.replace("/scan", "")}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(health.status, 503, "/health claimed healthy with clamd unreachable");
    assert.match(JSON.stringify(await health.json()), /clamd unreachable/);
  });

  test("and both recover once clamd answers again", async () => {
    clamdReply = "stream: OK";
    const live = await fetch(`${gatewayUrl.replace("/scan", "")}/live`);
    assert.equal(live.status, 200, "the readiness check did not clear");
  });

  test("/live does not report signature freshness", async () => {
    // Deliberate. A failing platform check restarts the machine, and a restart
    // does not make signatures fresher — it would loop while uploads were
    // already refusing correctly. Staleness belongs at scan time.
    const response = await fetch(`${gatewayUrl.replace("/scan", "")}/live`);
    const text = await response.text();
    assert.doesNotMatch(text, /signature|stale|age/i, "/live leaks scanner state");
  });

  test("/health still requires a token", async () => {
    const open = await fetch(`${gatewayUrl.replace("/scan", "")}/health`);
    assert.equal(open.status, 401, "/health answered without a token");
    const authed = await fetch(`${gatewayUrl.replace("/scan", "")}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authed.status, 200);
    assert.match(JSON.stringify(await authed.json()), /signatureAgeHours/);
  });

  test("/scan still requires a token", async () => {
    const response = await fetch(gatewayUrl, { method: "POST", body: new Uint8Array(BYTES) });
    assert.equal(response.status, 401, "adding /live opened up /scan");
  });
});

describe("the gateway will not start without a token", () => {
  test("an unauthenticated scanner refuses to run at all", async () => {
    const child = spawn(process.execPath, [GATEWAY], {
      env: { ...process.env, SCANNER_TOKEN: "", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.notEqual(code, 0, "the gateway started with no token, which is an open relay");
    assert.match(stderr, /SCANNER_TOKEN is not set/);
  });
});
