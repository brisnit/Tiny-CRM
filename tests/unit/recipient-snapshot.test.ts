import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The audience comparison, exercised through the real script.
 *
 * Imported from scripts/review-recipients.mjs rather than reimplemented. An
 * earlier version of this check tested a copy of the logic pasted into a
 * scratch file, which passed while the script itself held
 * `const idOf = (email) = createHash(...)` — a missing arrow that assigns to
 * a parenthesized identifier. That is VALID syntax, so `node --check` exits
 * 0; it fails at module evaluation, under strict mode, with a ReferenceError.
 * Only loading the real module finds it, which is why these import it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Loaded in a hook rather than at the top level: tsx transforms this file to
// CommonJS, where top-level await is a build error.
let idOf: any, mask: any, compareAudience: any, snapshotPayload: any;

before(async () => {
  const mod: any = await import("../../scripts/review-recipients.mjs");
  ({ idOf, mask, compareAudience, snapshotPayload } = mod);
  assert.equal(typeof idOf, "function", "the script did not export idOf — did it fail to evaluate?");
});

const rows = (...emails: string[]) =>
  emails.map((email) => ({ email, created_at: new Date("2026-10-01"), plan: "free", verified: true }));

const APPROVED = rows(
  "a@x.test", "b@x.test", "c@y.test", "d@y.test",
  "e@z.test", "f@z.test", "g@w.test", "h@w.test",
);

const snapshotOf = (include: ReturnType<typeof rows>) =>
  snapshotPayload({ database: "test", accounts: include.length, include, exclude: 0, ambiguous: 0 });

describe("the recipient snapshot and comparison", () => {
  test("an unchanged audience reports no change", () => {
    const d = compareAudience(snapshotOf(APPROVED), APPROVED);
    assert.equal(d.added.length, 0);
    assert.equal(d.removed.length, 0);
    assert.equal(d.approvedCount, 8);
    assert.equal(d.currentCount, 8);
  });

  test("a new signup is reported, with the address available to act on", () => {
    const now = [...APPROVED, ...rows("new@person.test")];
    const d = compareAudience(snapshotOf(APPROVED), now);
    assert.equal(d.added.length, 1);
    assert.equal(d.added[0].email, "new@person.test");
    assert.equal(d.removed.length, 0);
  });

  test("a departed account is reported, masked", () => {
    const d = compareAudience(snapshotOf(APPROVED), APPROVED.slice(0, 7));
    assert.equal(d.removed.length, 1);
    assert.match(d.removed[0].masked, /@w\.test$/);
    assert.doesNotMatch(d.removed[0].masked, /^h@/, "the local part was not masked");
  });

  test("case and surrounding whitespace are not a change", () => {
    const shouting = APPROVED.map((r) => ({ ...r, email: ` ${r.email.toUpperCase()} ` }));
    const d = compareAudience(snapshotOf(APPROVED), shouting);
    assert.equal(d.added.length, 0, "a capitalised address was read as a new person");
    assert.equal(d.removed.length, 0);
  });

  test("the snapshot file contains no email address", () => {
    /**
     * The property that makes it safe to leave on disk. Asserted on the
     * serialised bytes, because that is what would leak, not on the object.
     */
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    try {
      const path = join(dir, "recipient-snapshot.json");
      writeFileSync(path, JSON.stringify(snapshotOf(APPROVED), null, 2));
      const text = readFileSync(path, "utf8");
      for (const row of APPROVED) {
        assert.ok(!text.includes(row.email), `the file contains ${row.email}`);
      }
      assert.ok(text.includes(idOf("a@x.test")), "the hash that makes comparison work is missing");
      assert.equal(JSON.parse(text).recipients.length, 8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty or malformed snapshot does not read as 'no change'", () => {
    // Everyone looks new against nothing, which is the honest answer and the
    // opposite of silently reporting that the audience is unchanged.
    for (const before of [undefined, null, {}, { recipients: [] }]) {
      const d = compareAudience(before, APPROVED);
      assert.equal(d.added.length, 8, `a ${JSON.stringify(before)} snapshot hid every recipient`);
    }
  });

  test("mask keeps the domain and hides the local part", () => {
    assert.equal(mask("someone@client.test"), "s••••••@client.test");
    assert.equal(mask("a@client.test"), "a•@client.test");
    assert.equal(mask("not-an-address"), "[unreadable]");
  });
});
