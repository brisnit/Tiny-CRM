import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Structural enforcement of the RLS request-context architecture.
 *
 * The application talks to PostgreSQL as `tinycrm_app`, which is bound by row-
 * level security. A workspace-scoped query only sees rows when it runs inside a
 * tenant context, and a query that does not establish one does not error — it
 * quietly returns nothing on a read and is refused on a write. That failure mode
 * is invisible in development, where SQLite has no policies at all, and is how
 * the hosted deployment ended up unable to create a workspace or write an audit
 * row while every local test passed.
 *
 * So this is a lint, not a document. Adding
 *
 *     const rows = await db.contact.findMany(...)
 *
 * to a page or a route handler without a surrounding `scopedRead` /
 * `withTenantContext` fails CI, with the file and line named.
 */

/** Models that carry a workspaceId, or hang off something that does. */
const TENANT_MODELS = [
  "workspace", "workspaceMember", "company", "contact", "projectStatus", "project",
  "milestone", "pipeline", "pipelineStage", "deal", "opportunity", "task", "note",
  "activity", "fileAsset", "tag", "tagLink", "customFieldDef", "customFieldValue",
  "savedView", "automation", "automationRun", "aiInsight", "aiThread", "aiMessage",
  "notification", "integration", "emailMessage", "calendarEvent", "eventAttendee",
  "auditLog", "domainEvent", "jobRun", "securityAlert", "projectContact",
  "dealContact", "opportunityContact", "importBatch", "workspaceInvitation",
];

/** Establishes tenant context; a call inside one of these is compliant. */
const WRAPPERS = ["scopedRead(", "withTenantContext(", "withoutTenantContext("];

/**
 * Directories whose every database call is wrapped by construction, each with
 * the mechanism that guarantees it and the test that proves the mechanism.
 */
const COVERED_BY_CONSTRUCTION: Record<string, string> = {
  "src/lib/actions":
    "every export runs through action/workspaceAction/recordAction in base.ts, " +
    "each of which establishes context; enforced by the guard() structural test",
  "src/lib/data":
    "every exported entry point wraps its body in withTenantContext using the " +
    "workspaceIds it was handed by resolveReadScope",
};

/**
 * Files whose *private* helpers may read tenant models without a wrapper of
 * their own, because every exported entry point in the file establishes context
 * before calling them. The rule this encodes is deliberate: an exported
 * function is reachable from anywhere and must establish its own context; a
 * module-private one is reachable only from its own file's exports, which this
 * list asserts are wrapped.
 *
 * Listing a file here is a claim that a reviewer checked its exports. The test
 * below verifies the claim mechanically rather than trusting it: every exported
 * async function in these files that touches a tenant model must itself be
 * wrapped.
 */
const PRIVATE_HELPERS_INHERIT: Record<string, string> = {
  "src/lib/ai/context.ts": "buildWorkspaceSnapshot and buildRecordContext both wrap",
  "src/lib/ai/crm-agent.ts":
    "askTinyAi is a generator and cannot hold a transaction across a stream; its " +
    "reads wrap inside context.ts and its single write is wrapped at the site",
  "src/lib/automations.ts": "runAutomations wraps; applyAction is private to it",
  "src/lib/ai/summaries.ts": "both exports wrap",
  "src/lib/ai/recommendations.ts": "findRecommendations wraps",
  "src/lib/ai/classification.ts": "classifyText wraps",
};

/**
 * Individually reviewed exceptions. Each names why the call is legitimately
 * outside a tenant context. Anything not listed here must be wrapped.
 */
const EXCEPTIONS: Record<string, string> = {
  "src/lib/db.ts": "defines the mechanism",
  "src/lib/tenant-db.ts": "defines the mechanism",
  "src/lib/auth/context.ts":
    "getMemberships is the lookup that produces the context; it runs in a " +
    "user-only context and reads only rows naming that user (005 policies)",
  "src/lib/auth/access.ts":
    "requireRecordAccess resolves a record to its workspace inside a context of " +
    "the actor's own memberships",
  "src/lib/audit.ts": "establishes the context its own row claims",
  "src/lib/events.ts": "establishes context from the event's own workspace",
  "src/lib/jobs.ts":
    "the claim step uses the app_claim_jobs SECURITY DEFINER function on rootDb; " +
    "every job then runs inside withTenantContext for its own workspace",
  "src/lib/jobs/handlers.ts": "handlers run inside the job's tenant context",
  "src/lib/security/alerts.ts": "scopes each write to the alert's own workspace or user",
  "src/lib/ai/privacy.ts": "reads the workspace's AI mode in that workspace's context",
  "src/lib/entitlements.ts": "account-wide plan usage, isolated context over the actor's memberships",
  "src/lib/workspaces/provision.ts": "the workspace bootstrap; runs in the new workspace's context",
  "src/lib/data/scoped.ts": "defines the page-level wrapper",
  "src/lib/data/trash.ts": "wrapped at each export",
  "src/lib/auth/invitations.ts":
    "the token lookup is the one read that cannot run inside a tenant context — " +
    "an invitee has no membership, so any context would return nothing. The " +
    "token is the credential (256 bits, hashed at rest, single use, expiring), " +
    "exactly as for a password reset. Every write here wraps in the " +
    "invitation's own workspace, and prisma/postgres/004 makes the database " +
    "check the invitation independently rather than trusting this file",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "generated" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Whether the call on `lineIndex` sits inside a wrapper's callback.
 *
 * Tracks bracket depth from the top of the file, remembering the depth at which
 * each wrapper opened. A call is covered while at least one wrapper is still
 * open. Crude compared with a real parser, and deliberately so: it has no
 * dependencies, and it errs toward reporting a violation rather than missing
 * one — a false positive is a visible test failure, not a silent hole.
 */
function coveredLines(source: string): Set<number> {
  const lines = source.split("\n");
  const covered = new Set<number>();
  const openWrappers: number[] = [];
  let depth = 0;

  lines.forEach((line, index) => {
    const opensHere = WRAPPERS.some((w) => line.includes(w));
    const before = depth;
    for (const ch of line) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    while (openWrappers.length > 0 && depth <= openWrappers[openWrappers.length - 1]!) {
      openWrappers.pop();
    }
    if (opensHere) openWrappers.push(before);
    if (openWrappers.length > 0) covered.add(index);
  });

  return covered;
}


/** Line ranges of each `export ... function` body. */
function exportedFunctionSpans(source: string): [number, number][] {
  const lines = source.split("\n");
  const spans: [number, number][] = [];
  lines.forEach((line, index) => {
    if (!/^export (async )?function\*? \w+/.test(line)) return;
    let depth = 0;
    let started = false;
    for (let j = index; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      if (started && depth <= 0) { spans.push([index, j]); return; }
    }
  });
  return spans;
}

describe("workspace-scoped database access is inside a tenant context", () => {
  const modelPattern = new RegExp(`\\bdb\\.(${TENANT_MODELS.join("|")})\\.`);

  test("no unwrapped tenant-model access outside the approved mechanism", () => {
    const violations: string[] = [];

    for (const file of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (EXCEPTIONS[rel]) continue;
      if (Object.keys(COVERED_BY_CONSTRUCTION).some((d) => rel.startsWith(`${d}/`))) continue;

      const source = readFileSync(file, "utf8");
      if (!modelPattern.test(source)) continue;

      const covered = coveredLines(source);
      const inherits = Boolean(PRIVATE_HELPERS_INHERIT[rel]);
      const exportedSpans = inherits ? exportedFunctionSpans(source) : null;

      source.split("\n").forEach((line, index) => {
        if (!modelPattern.test(line)) return;
        if (covered.has(index)) return;
        // In an inheriting file, only calls inside an *exported* function are a
        // violation; a private helper is reached through one of those.
        if (exportedSpans && !exportedSpans.some(([a, b]) => index >= a && index <= b)) return;
        violations.push(`${rel}:${index + 1}  ${line.trim().slice(0, 90)}`);
      });
    }

    assert.deepEqual(
      violations,
      [],
      `These read or write a workspace-scoped model without establishing tenant context.\n` +
        `Under RLS a read returns nothing and a write is refused — silently.\n` +
        `Wrap the call in scopedRead(workspaceIds, …), or add a reviewed entry to\n` +
        `EXCEPTIONS in this file saying why it is legitimately outside one.\n\n` +
        violations.map((v) => `  ${v}`).join("\n"),
    );
  });

  test("every declared exception still exists", () => {
    // An exception for a deleted file is a rule nobody is checking any more.
    const missing = Object.keys(EXCEPTIONS).filter((rel) => {
      try {
        statSync(join(ROOT, rel));
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(missing, [], `EXCEPTIONS names files that no longer exist: ${missing.join(", ")}`);
  });

  test("every covered-by-construction directory still exists and is non-empty", () => {
    for (const dir of Object.keys(COVERED_BY_CONSTRUCTION)) {
      const files = walk(join(ROOT, dir));
      assert.ok(files.length > 0, `${dir} is empty — the exemption may be stale`);
    }
  });

  test("the detector actually detects", () => {
    // A guard on the guard: if coveredLines() ever returned "everything is
    // covered", this suite would pass while enforcing nothing.
    const bad = `import { db } from "@/lib/db";\nexport async function x() {\n  return db.contact.findMany();\n}\n`;
    const good = `import { db } from "@/lib/db";\nexport async function x() {\n  return scopedRead(ids, () => {\n    return db.contact.findMany();\n  });\n}\n`;
    assert.equal(coveredLines(bad).has(2), false, "an unwrapped call was reported as covered");
    assert.equal(coveredLines(good).has(3), true, "a wrapped call was reported as uncovered");
  });
});
