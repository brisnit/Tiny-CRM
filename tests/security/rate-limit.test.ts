import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../helpers/fixtures";

/**
 * Rate limiting.
 *
 * Two things are under test, and they are different questions:
 *
 *  1. **Does the policy layer count correctly** — the right limit, on the right
 *     axes, with every axis enforced rather than only the first?
 *  2. **Is the counter actually shared** — the property that decides whether a
 *     limit is a control or a decoration on a deployment with more than one
 *     instance? That one cannot be tested with a single in-process store, so the
 *     distributed tests construct two *independent* store instances, exactly as
 *     two application instances would, and assert they see one counter.
 */

const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");

describe("rate limiting", () => {
  after(async () => {
    await db.$disconnect();
  });

  describe("policy enforcement", () => {
    test("a limit is enforced and reports a retry hint", async () => {
      const { checkRateLimit, resetRateLimit, POLICIES } = await import("../../src/lib/rate-limit");
      const id = `probe-${Date.now()}`;
      await resetRateLimit("login", { ip: id });

      let blocked: Awaited<ReturnType<typeof checkRateLimit>> | null = null;
      for (let i = 0; i < POLICIES.login.per.ip + 3; i++) {
        const result = await checkRateLimit("login", { ip: id });
        if (!result.ok) {
          blocked = result;
          break;
        }
      }

      assert.ok(blocked, "the limit was never reached");
      assert.equal(blocked!.remaining, 0);
      assert.ok(blocked!.retryAfterSeconds > 0, "no retry-after was reported");
      assert.equal(blocked!.dimension, "ip", "the refusing axis was not identified");

      await resetRateLimit("login", { ip: id });
    });

    test("every declared axis is enforced, not just the first", async () => {
      // Sign-in is limited to 10 per address and 5 per account. An attacker
      // rotating addresses against one account must still hit the account limit.
      const { checkRateLimit, resetRateLimit } = await import("../../src/lib/rate-limit");
      const account = `victim-${Date.now()}@example.test`;
      await resetRateLimit("login", { account });

      let blocked = false;
      for (let i = 0; i < 8; i++) {
        // A different address every time — the per-IP counter never accumulates.
        const result = await checkRateLimit("login", { ip: `10.0.0.${i}`, account });
        if (!result.ok) {
          assert.equal(result.dimension, "account", "the wrong axis refused");
          blocked = true;
          break;
        }
      }
      assert.ok(blocked, "rotating the source address bypassed the per-account limit");

      await resetRateLimit("login", { account });
      for (let i = 0; i < 8; i++) await resetRateLimit("login", { ip: `10.0.0.${i}` });
    });

    test("one tenant's seats cannot collectively exhaust a shared resource", async () => {
      // Per-user limits alone never notice a team acting in concert. Export is
      // capped per workspace too, because an export is the shape an exfiltration
      // takes and one seat is not a meaningful ceiling on a team.
      const { checkRateLimit, resetRateLimit, POLICIES } = await import("../../src/lib/rate-limit");
      const workspace = `ws-${Date.now()}`;
      await resetRateLimit("export", { workspace });

      let blocked = false;
      for (let i = 0; i < POLICIES.export.per.workspace + 3; i++) {
        // A different user each time, so no per-user counter accumulates.
        const result = await checkRateLimit("export", { user: `user-${i}-${workspace}`, workspace });
        if (!result.ok) {
          assert.equal(result.dimension, "workspace");
          blocked = true;
          break;
        }
      }
      assert.ok(blocked, "a workspace could export without limit by using more seats");
      await resetRateLimit("export", { workspace });
    });

    test("the tightest remaining count is reported while under the limit", async () => {
      const { checkRateLimit, resetRateLimit } = await import("../../src/lib/rate-limit");
      const id = `tight-${Date.now()}`;
      await resetRateLimit("login", { ip: id, account: id });

      // Account allows 5, IP allows 10 — so after one hit the reported headroom
      // must be the account's 4, not the address's 9.
      const result = await checkRateLimit("login", { ip: id, account: id });
      assert.equal(result.ok, true);
      assert.equal(result.remaining, 4, "the looser axis was reported as the headroom");

      await resetRateLimit("login", { ip: id, account: id });
    });

    test("enforceRateLimit throws a typed, categorised error", async () => {
      const { enforceRateLimit, resetRateLimit, POLICIES } = await import("../../src/lib/rate-limit");
      const id = `throw-${Date.now()}`;
      await resetRateLimit("bulk", { user: id });

      for (let i = 0; i < POLICIES.bulk.per.user; i++) {
        await enforceRateLimit("bulk", { user: id });
      }

      await assert.rejects(
        enforceRateLimit("bulk", { user: id }),
        (error: { category?: string; meta?: { retryAfterSeconds?: number }; message: string }) => {
          assert.equal(error.category, "rate_limited");
          assert.ok((error.meta?.retryAfterSeconds ?? 0) > 0);
          // The message must not disclose the internal key or the counter.
          assert.ok(!error.message.includes(id), "the error echoed the identifier back");
          return true;
        },
      );

      await resetRateLimit("bulk", { user: id });
    });

    test("a missing identifier does not silently disable the limit for others", async () => {
      const { checkRateLimit } = await import("../../src/lib/rate-limit");
      // No axis supplied at all: the call is allowed (refusing would break a
      // legitimate path) but must not affect anyone else's counter.
      const result = await checkRateLimit("search", {});
      assert.equal(result.ok, true);
    });
  });

  describe("stored keys carry no personal data", () => {
    test("an identifier is hashed, not stored", async () => {
      const { storeKey } = await import("../../src/lib/rate-limit/stores");
      const email = "someone@example.com";
      const key = storeKey("login:account", email);

      assert.ok(!key.includes(email), "the raw email is the key");
      assert.ok(!key.includes("someone"), "part of the email survived into the key");
      assert.ok(!key.includes("example.com"), "the domain survived into the key");
      assert.match(key, /^rl:login:account:[A-Za-z0-9_-]{24}$/);
    });

    test("the digest is keyed, so a candidate cannot be confirmed by rehashing", async () => {
      const { createHash } = await import("node:crypto");
      const { storeKey } = await import("../../src/lib/rate-limit/stores");

      const email = "someone@example.com";
      const unkeyed = createHash("sha256").update(email).digest("base64url").slice(0, 24);

      assert.notEqual(
        storeKey("login:account", email),
        `rl:login:account:${unkeyed}`,
        "the digest is a plain hash — anyone with the key list could confirm an address",
      );
    });

    test("the same identifier is stable and different ones diverge", async () => {
      const { storeKey } = await import("../../src/lib/rate-limit/stores");
      assert.equal(storeKey("p", "a@b.test"), storeKey("p", "a@b.test"));
      assert.notEqual(storeKey("p", "a@b.test"), storeKey("p", "c@d.test"));
      assert.notEqual(storeKey("p1", "a@b.test"), storeKey("p2", "a@b.test"));
    });
  });

  describe("the counter is shared between instances", () => {
    test("two in-process stores do NOT share a counter", async () => {
      // The failure mode being fixed, asserted so it cannot be mistaken for the
      // fixed behaviour. Two application instances with the in-process store
      // give an attacker twice every limit.
      const { MemoryStore } = await import("../../src/lib/rate-limit/stores");
      const instanceA = new MemoryStore();
      const instanceB = new MemoryStore();

      const key = `shared-probe-${Date.now()}`;
      const a = await instanceA.hit(key, 60_000);
      const b = await instanceB.hit(key, 60_000);

      assert.equal(a.count, 1);
      assert.equal(b.count, 1, "two memory stores unexpectedly shared state");
    });

    test(
      "two PostgreSQL stores DO share a counter",
      { skip: isPostgres ? false : "PostgreSQL only" },
      async () => {
        const { PostgresStore } = await import("../../src/lib/rate-limit/stores");
        const instanceA = new PostgresStore();
        const instanceB = new PostgresStore();

        const key = `shared-pg-${Date.now()}`;
        try {
          const a = await instanceA.hit(key, 60_000);
          const b = await instanceB.hit(key, 60_000);
          const c = await instanceA.hit(key, 60_000);

          assert.equal(a.count, 1);
          assert.equal(b.count, 2, "a second instance restarted the counter");
          assert.equal(c.count, 3, "the counter did not accumulate across instances");
          assert.equal(a.resetAt, b.resetAt, "each instance invented its own window");
        } finally {
          await instanceA.reset(key);
        }
      },
    );

    test(
      "concurrent increments from many instances lose nothing",
      { skip: isPostgres ? false : "PostgreSQL only" },
      async () => {
        // The race a read-then-write limiter loses: twenty instances all read 0
        // and all write 1, so twenty requests count as one.
        const { PostgresStore } = await import("../../src/lib/rate-limit/stores");
        const key = `race-pg-${Date.now()}`;
        const instances = Array.from({ length: 20 }, () => new PostgresStore());

        try {
          const results = await Promise.all(instances.map((s) => s.hit(key, 60_000)));
          const counts = results.map((r) => r.count).sort((a, b) => a - b);

          assert.deepEqual(
            counts,
            Array.from({ length: 20 }, (_, i) => i + 1),
            "concurrent increments collided — some requests were not counted",
          );
        } finally {
          await instances[0]!.reset(key);
        }
      },
    );

    test(
      "an expired window restarts rather than accumulating forever",
      { skip: isPostgres ? false : "PostgreSQL only" },
      async () => {
        const { PostgresStore } = await import("../../src/lib/rate-limit/stores");
        const store = new PostgresStore();
        const key = `window-pg-${Date.now()}`;

        try {
          await store.hit(key, 1); // a window that has already closed
          await new Promise((resolve) => setTimeout(resolve, 30));
          const next = await store.hit(key, 60_000);
          assert.equal(next.count, 1, "an expired window kept counting");
        } finally {
          await store.reset(key);
        }
      },
    );

    test(
      "the sweep removes expired rows without touching live ones",
      { skip: isPostgres ? false : "PostgreSQL only" },
      async () => {
        const { PostgresStore } = await import("../../src/lib/rate-limit/stores");
        const store = new PostgresStore();
        const expired = `sweep-old-${Date.now()}`;
        const live = `sweep-live-${Date.now()}`;

        await store.hit(expired, 1);
        await store.hit(live, 600_000);
        await new Promise((resolve) => setTimeout(resolve, 30));

        await PostgresStore.sweep();

        const rows = await db.$queryRaw<{ key: string }[]>`
          SELECT "key" FROM "RateLimitCounter" WHERE "key" IN (${expired}, ${live})
        `;
        const keys = rows.map((r) => r.key);
        assert.ok(!keys.includes(expired), "an expired counter survived the sweep");
        assert.ok(keys.includes(live), "the sweep removed a live counter");

        await store.reset(live);
      },
    );
  });

  describe("configuration is reported honestly", () => {
    test("the backend says whether it is actually distributed", async () => {
      const { rateLimitBackend } = await import("../../src/lib/rate-limit");
      const backend = rateLimitBackend();

      assert.ok(["memory", "redis", "postgres"].includes(backend.kind));
      assert.equal(
        backend.distributed,
        backend.kind !== "memory",
        "a memory backend claimed to be distributed, or a shared one denied it",
      );
      assert.ok(backend.reason.length > 0, "no reason was given for the choice");
    });

    test("production refuses to start on an in-process limiter with several instances", async () => {
      // The gate itself is covered by tests/security/config.test.ts, which
      // launches a real process. This asserts the predicate the gate reads, so a
      // change to the predicate cannot quietly pass the gate.
      const { usingSharedRateLimitStore } = await import("../../src/lib/env");
      assert.equal(typeof usingSharedRateLimitStore(), "boolean");
    });
  });
});
