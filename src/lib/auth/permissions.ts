/**
 * Centralised permission model.
 *
 * Roles map to permissions in exactly one table. Nothing anywhere else in the
 * codebase compares a role string — call sites ask "can this actor do X in this
 * workspace", which means a role change is a single edit here rather than a hunt
 * for `if (role === "admin")`.
 *
 * This file is deliberately free of imports so it can be unit-tested and used on
 * both sides of the client/server boundary. UI may read it to hide affordances;
 * that is a convenience. Enforcement happens in src/lib/auth/access.ts, on the
 * server, on every mutation.
 */

export const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "record:view",
  "record:create",
  "record:edit",
  "record:archive",
  "record:delete",
  "record:export",
  "workspace:manage",
  "workspace:delete",
  "members:manage",
  "billing:manage",
  "automations:manage",
  "integrations:manage",
  "pipelines:manage",
  "fields:manage",
  "ai:use",
  "ai:apply",
  "import:run",
  "audit:view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Explicit grants per role. Written out in full rather than derived by
 * inheritance so that reading any row tells you exactly what that role can do.
 */
const GRANTS: Record<Role, readonly Permission[]> = {
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

  owner: [
    "record:view", "record:create", "record:edit", "record:archive", "record:delete",
    "record:export", "workspace:manage", "workspace:delete", "members:manage",
    "billing:manage", "automations:manage", "integrations:manage", "pipelines:manage",
    "fields:manage", "ai:use", "ai:apply", "import:run", "audit:view",
  ],
};

const GRANT_SETS = ROLES.reduce(
  (acc, role) => {
    acc[role] = new Set(GRANTS[role]);
    return acc;
  },
  {} as Record<Role, ReadonlySet<Permission>>,
);

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: string): ReadonlySet<Permission> {
  return isRole(role) ? GRANT_SETS[role] : GRANT_SETS.viewer;
}

/** The single predicate the whole application uses. */
export function can(role: string, permission: Permission): boolean {
  return permissionsFor(role).has(permission);
}

export function canAll(role: string, permissions: Permission[]): boolean {
  const granted = permissionsFor(role);
  return permissions.every((p) => granted.has(p));
}

/** Ranking, used only to stop a role being escalated above the actor's own. */
const RANK: Record<Role, number> = { viewer: 0, member: 1, manager: 2, admin: 3, owner: 4 };

export function roleRank(role: string): number {
  return isRole(role) ? RANK[role] : -1;
}

/**
 * Whether `actor` may assign `target` to someone else. A role can never be
 * granted at or above the granter's own level, which stops an admin minting
 * another owner.
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (!can(actorRole, "members:manage")) return false;
  if (!isRole(targetRole)) return false;
  if (actorRole === "owner") return true;
  return roleRank(targetRole) < roleRank(actorRole);
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control, including billing and deleting the workspace.",
  admin: "Manage settings, members, integrations and every record.",
  manager: "Manage and delete all records, export data, configure pipelines.",
  member: "Create and edit records. Cannot delete or export.",
  viewer: "Read-only access.",
};
