import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { canSeeImported, visibleToUser } from "../../src/lib/integrations/visibility";

/**
 * The application-level half of imported-record privacy.
 *
 * `prisma/postgres/016_integration_privacy.sql` is the layer that holds when
 * application code forgets, and it is tested against the restricted role in
 * tests/security/integration-privacy.test.ts. This is the layer that runs
 * first, and it is the only one that exists on SQLite — so without these a
 * development environment would show every teammate's mail to everyone and the
 * fast suite could not tell.
 */
describe("who may see an imported record", () => {
  test("the shape spread into a query asks for shared rows plus my own private ones", () => {
    const where = visibleToUser("u_me");
    assert.deepEqual(where, {
      OR: [
        { visibility: { not: "private" } },
        { visibility: "private", ownerUserId: "u_me" },
      ],
    });
  });

  test("private is mine alone; shared and seeded are everyone's", () => {
    const mine = { visibility: "private", ownerUserId: "u_me" };
    const theirs = { visibility: "private", ownerUserId: "u_them" };
    const shared = { visibility: "workspace", ownerUserId: "u_them" };
    const seeded = { visibility: "workspace", ownerUserId: null };

    assert.equal(canSeeImported(mine, "u_me"), true);
    assert.equal(canSeeImported(theirs, "u_me"), false, "a colleague's private mail was readable");
    assert.equal(canSeeImported(shared, "u_me"), true, "a deliberately shared row was hidden");
    assert.equal(canSeeImported(seeded, "u_me"), true, "seeded demonstration data was hidden");
  });

  test("a private row with no owner is readable by nobody", () => {
    // Should not occur — the sync worker always sets an owner — and if it does,
    // invisible is the failure worth having.
    assert.equal(canSeeImported({ visibility: "private", ownerUserId: null }, "u_me"), false);
  });

  test("an unrecognised visibility is treated as shared, not as private", () => {
    // Stated so the choice is deliberate and reviewable. The database policy
    // takes the opposite default (`<> 'private'` means anything unknown is
    // readable there too), so both layers agree: only the literal string
    // "private" restricts. A new value must be added to both.
    assert.equal(canSeeImported({ visibility: "something-new", ownerUserId: "u_them" }, "u_me"), true);
  });
});
