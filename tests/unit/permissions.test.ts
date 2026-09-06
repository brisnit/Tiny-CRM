import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PERMISSIONS, ROLES, can, canAll, canAssignRole, permissionsFor, roleRank,
  type Permission, type Role,
} from "../../src/lib/auth/permissions";

/**
 * The RBAC matrix, asserted directly.
 *
 * The permission table is the only place in the codebase that decides what a
 * role may do, so it is worth testing exhaustively rather than by sampling: a
 * grant added to the wrong row is a silent privilege escalation that no
 * feature test would notice.
 */
describe("permissions", () => {
  describe("the grant matrix", () => {
    /**
     * The expected matrix, written out independently of the implementation.
     * If these two ever disagree, one of them is a bug — and the reviewer has
     * to decide which, which is the point.
     */
    const EXPECTED: Record<Role, Permission[]> = {
      viewer: ["record:view"],
      member: ["record:view", "record:create", "record:edit", "record:archive", "ai:use", "ai:apply"],
      manager: [
        "record:view", "record:create", "record:edit", "record:archive", "record:delete",
        "record:export", "automations:manage", "pipelines:manage", "fields:manage",
        "ai:use", "ai:apply", "import:run",
      ],
      admin: [
        "record:view", "record:create", "record:edit", "record:archive", "record:delete",
        "record:export", "workspace:manage", "members:manage", "automations:manage",
        "integrations:manage", "pipelines:manage", "fields:manage",
        "ai:use", "ai:apply", "import:run", "audit:view",
      ],
      owner: [...PERMISSIONS],
    };

    for (const role of ROLES) {
      test(`${role} holds exactly its documented grants`, () => {
        const actual = [...permissionsFor(role)].sort();
        assert.deepEqual(actual, [...EXPECTED[role]].sort(), `${role}'s grants drifted`);
      });
    }

    test("a viewer can do nothing but read", () => {
      for (const permission of PERMISSIONS) {
        if (permission === "record:view") continue;
        assert.equal(can("viewer", permission), false, `viewer was granted ${permission}`);
      }
    });

    test("only the owner can delete the workspace or manage billing", () => {
      for (const role of ROLES) {
        const expected = role === "owner";
        assert.equal(can(role, "workspace:delete"), expected);
        assert.equal(can(role, "billing:manage"), expected);
      }
    });

    test("members can neither delete nor export", () => {
      assert.equal(can("member", "record:delete"), false);
      assert.equal(can("member", "record:export"), false);
      assert.equal(can("member", "import:run"), false);
    });

    test("an unknown role degrades to viewer, never to owner", () => {
      // A role string that is not in the table can arrive from a stale row or a
      // bad migration. It must fail closed.
      for (const bogus of ["superuser", "admin ", "OWNER", "", "root"]) {
        assert.deepEqual([...permissionsFor(bogus)], ["record:view"], `"${bogus}" was not treated as a viewer`);
      }
    });

    test("canAll requires every permission, not any", () => {
      assert.equal(canAll("member", ["record:create", "record:edit"]), true);
      assert.equal(canAll("member", ["record:create", "record:delete"]), false);
      assert.equal(canAll("owner", [...PERMISSIONS]), true);
    });
  });

  describe("role assignment", () => {
    test("nobody without members:manage can assign a role", () => {
      for (const role of ["viewer", "member", "manager"] as const) {
        for (const target of ROLES) {
          assert.equal(canAssignRole(role, target), false, `${role} could grant ${target}`);
        }
      }
    });

    test("an admin cannot mint an owner or another admin", () => {
      assert.equal(canAssignRole("admin", "owner"), false, "an admin created an owner");
      assert.equal(canAssignRole("admin", "admin"), false, "an admin cloned itself");
      assert.equal(canAssignRole("admin", "manager"), true);
      assert.equal(canAssignRole("admin", "viewer"), true);
    });

    test("an owner may assign any real role", () => {
      for (const target of ROLES) {
        assert.equal(canAssignRole("owner", target), true, `owner could not grant ${target}`);
      }
    });

    test("an invented role can never be assigned", () => {
      for (const bogus of ["superuser", "", "owner ", "Owner"]) {
        assert.equal(canAssignRole("owner", bogus), false, `"${bogus}" was assignable`);
      }
    });

    test("ranking is strictly ordered and unknown roles rank below everything", () => {
      const ranks = ROLES.map(roleRank);
      assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), "role ranks are not ordered");
      assert.equal(roleRank("nonsense"), -1);
    });
  });
});
