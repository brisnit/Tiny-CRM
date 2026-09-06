/**
 * Workspace lifecycle policy.
 *
 * Plain constants, in their own module rather than beside the actions that use
 * them: every export of a `"use server"` file must be an async function, so a
 * constant exported from one is a build error. That is worth knowing rather than
 * working around — the rule exists because each export of such a module is a
 * callable HTTP endpoint, and a constant cannot be one.
 *
 * No imports, so this is readable from both server and client code.
 */

/**
 * How long a workspace sits scheduled for deletion before it is destroyed.
 *
 * A week: long enough that a mis-click, a stolen session or a bad afternoon can
 * be undone, short enough that "I asked you to delete my data" is still honoured
 * promptly. The clock is visible in the UI throughout.
 */
export const WORKSPACE_DELETION_GRACE_DAYS = 7;

/** How long an archived record stays in trash before it may be purged. */
export const TRASH_RETENTION_DAYS = 30;
