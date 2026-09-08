#!/usr/bin/env node
/**
 * The Neon recovery drill.
 *
 * `npm run test:backup` proves the data round-trips through a dump and restore
 * this repository writes itself. It says nothing about the provider: whether
 * Neon can actually reconstruct a past state, whether row-level security
 * survives that reconstruction, and whether the restored database still refuses
 * cross-tenant reads. An untested provider backup is a hypothesis, and the
 * hypothesis that matters most is the one nobody checks until an incident.
 *
 * This exercises it end to end:
 *
 *   seed        create a marked two-tenant fixture in production
 *   fingerprint hash the fixture deterministically, from any database
 *   verify      assert isolation and integrity, from any database
 *   cleanup     remove the fixture from production, by recorded id only
 *
 * ---------------------------------------------------------------------------
 * Why a fixture has to exist at all
 * ---------------------------------------------------------------------------
 *
 * Production holds almost no CRM data — a handful of audit rows, one user, no
 * contacts, companies or deals. Restoring that proves the mechanism runs but
 * cannot prove a record came back, that a relationship survived, or that tenant
 * A still cannot read tenant B. So a small, unmistakably marked fixture is
 * written *before* the recovery point is taken, and removed afterwards.
 *
 * ---------------------------------------------------------------------------
 * Which role does what, and why it matters
 * ---------------------------------------------------------------------------
 *
 * Seeding and cleanup use the owner connection, because creating users and
 * workspaces is setup, exactly as seeding does elsewhere in this repository.
 *
 * **Every isolation assertion uses the restricted `tinycrm_app` role**, and the
 * script refuses to run them as anything else. Asserting isolation over a
 * connection with BYPASSRLS would prove nothing at all while looking identical
 * in the output, which is the most dangerous shape a passing test can have.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const CONFIG = `${homedir()}/.config/tinycrm`;
const MANIFEST = `${CONFIG}/restore-probe-manifest.json`;
const MARK = "RESTORE_PROBE";

let passed = 0, failed = 0;
const pass = (n, d = "") => { passed++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ""}`); };
const fail = (n, d = "") => { failed++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); };
const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);
const id = (p = "c") => `${p}${randomUUID().replace(/-/g, "")}`;

const read = (name) => readFileSync(`${CONFIG}/${name}`, "utf8").trim();

/**
 * The owner connection used for setup and cleanup.
 *
 * `PROBE_ADMIN_URL` exists so the harness can be rehearsed against a throwaway
 * cluster before it is ever pointed at production. A drill script whose first
 * execution is against the real database is not a drill, it is an experiment.
 */
const adminUrl = () => process.env.PROBE_ADMIN_URL || read("neon-owner.url");
const connect = async (url) => {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
  await c.connect();
  return c;
};

/**
 * The fixture's shape, as a projection.
 *
 * The fingerprint is taken over exactly these columns, ordered by id, so it is
 * reproducible from any database holding the same rows. Volatile columns are
 * deliberately excluded — a hash that changes on its own proves nothing when it
 * differs after a restore.
 */
const SHAPE = [
  ["Workspace", ["id", "name", "slug"]],
  ["User", ["id", "email", "name"]],
  ["WorkspaceMember", ["id", "workspaceId", "userId", "role"]],
  ["Company", ["id", "workspaceId", "name", "ownerId", "primaryContactId"]],
  ["Contact", ["id", "workspaceId", "fullName", "companyId", "ownerId"]],
  ["Pipeline", ["id", "workspaceId", "name"]],
  ["PipelineStage", ["id", "pipelineId", "name"]],
  ["Deal", ["id", "workspaceId", "name", "pipelineId", "stageId", "companyId", "primaryContactId"]],
  ["Task", ["id", "workspaceId", "title", "contactId", "dealId"]],
  ["Note", ["id", "workspaceId", "title", "contactId", "dealId", "authorId"]],
  ["AuditLog", ["id", "workspaceId", "action", "summary"]],
  ["SecurityAlert", ["id", "workspaceId", "kind", "summary", "dedupeKey"]],
];

function loadManifest() {
  if (!existsSync(MANIFEST)) {
    console.error(`No manifest at ${MANIFEST}. Run \`seed\` first.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/** Every id the fixture created, flattened. Cleanup will not touch anything else. */
function allIds(m) {
  const out = new Set();
  for (const [, rows] of Object.entries(m.rows)) for (const r of rows) out.add(r.id);
  return out;
}

// ---------------------------------------------------------------------------

async function fingerprintOf(client, manifest) {
  const parts = [];
  for (const [table, cols] of SHAPE) {
    const ids = (manifest.rows[table] ?? []).map((r) => r.id);
    if (!ids.length) continue;
    const quoted = cols.map((c) => `"${c}"`).join(", ");
    const { rows } = await client.query(
      `SELECT ${quoted} FROM "${table}" WHERE id = ANY($1::text[]) ORDER BY id`, [ids]);
    // Canonical: fixed column order, fixed row order, nulls explicit.
    for (const row of rows) {
      parts.push(`${table}|` + cols.map((c) => (row[c] === null ? "\\N" : String(row[c]))).join("|"));
    }
    parts.push(`${table}#count=${rows.length}/${ids.length}`);
  }
  const canonical = parts.join("\n");
  return { hash: createHash("sha256").update(canonical).digest("hex"), lines: parts.length, canonical };
}

// ---------------------------------------------------------------------------

async function seed() {
  const admin = await connect(adminUrl());
  const stamp = Date.now();
  const rows = Object.fromEntries(SHAPE.map(([t]) => [t, []]));
  const track = (t, id, note) => rows[t].push({ id, note });

  const tenant = (label) => ({
    label,
    userId: id(), workspaceId: id(), memberId: id(),
    companyId: id(), contactId: id(), pipelineId: id(), stageId: id(),
    dealId: id(), taskId: id(), noteId: id(), auditId: id(), alertId: id(),
    email: `${MARK}_${label}_${stamp}@restore-probe.invalid`,
  });
  const A = tenant("A"), B = tenant("B");

  try {
    await admin.query("BEGIN");
    for (const t of [A, B]) {
      const name = `${MARK}_${t.label}`;
      // A temporary identity. `.invalid` is reserved by RFC 2606 and can never
      // receive mail, so this cannot become a real account by accident.
      await admin.query(
        `INSERT INTO "User" (id,email,name,"passwordHash","emailVerifiedAt","updatedAt")
         VALUES ($1,$2,$3,$4,now(),now())`,
        [t.userId, t.email, `${name}_USER`, await bcrypt.hash(`Pw-${randomUUID()}`, 10)]);
      track("User", t.userId, name);

      await admin.query(
        `INSERT INTO "Workspace" (id,name,slug,"ownerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [t.workspaceId, `${name}_WORKSPACE`, `${MARK.toLowerCase()}-${t.label.toLowerCase()}-${stamp}`, t.userId]);
      track("Workspace", t.workspaceId, name);

      await admin.query(
        `INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role) VALUES ($1,$2,$3,'owner')`,
        [t.memberId, t.workspaceId, t.userId]);
      track("WorkspaceMember", t.memberId, name);

      await admin.query(
        `INSERT INTO "Company" (id,"workspaceId",name,"ownerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [t.companyId, t.workspaceId, `${name}_COMPANY`, t.userId]);
      track("Company", t.companyId, name);

      await admin.query(
        `INSERT INTO "Contact" (id,"workspaceId","firstName","lastName","fullName","companyId","ownerId","updatedAt")
         VALUES ($1,$2,$3,'PROBE',$4,$5,$6,now())`,
        [t.contactId, t.workspaceId, `${name}_CONTACT`, `${name}_CONTACT PROBE`, t.companyId, t.userId]);
      track("Contact", t.contactId, name);

      // Closes the Company -> Contact cycle: this is the circular FK that made a
      // logical restore impossible until the constraints were made DEFERRABLE.
      await admin.query(`UPDATE "Company" SET "primaryContactId" = $1 WHERE id = $2`, [t.contactId, t.companyId]);

      await admin.query(
        `INSERT INTO "Pipeline" (id,"workspaceId",name) VALUES ($1,$2,$3)`,
        [t.pipelineId, t.workspaceId, `${name}_PIPELINE`]);
      track("Pipeline", t.pipelineId, name);

      await admin.query(
        `INSERT INTO "PipelineStage" (id,"pipelineId",name) VALUES ($1,$2,$3)`,
        [t.stageId, t.pipelineId, `${name}_STAGE`]);
      track("PipelineStage", t.stageId, name);

      await admin.query(
        `INSERT INTO "Deal" (id,"workspaceId",name,"pipelineId","stageId","companyId","primaryContactId","ownerId","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [t.dealId, t.workspaceId, `${name}_DEAL`, t.pipelineId, t.stageId, t.companyId, t.contactId, t.userId]);
      track("Deal", t.dealId, name);

      await admin.query(
        `INSERT INTO "Task" (id,"workspaceId",title,"contactId","dealId","ownerId","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [t.taskId, t.workspaceId, `${name}_TASK`, t.contactId, t.dealId, t.userId]);
      track("Task", t.taskId, name);

      await admin.query(
        `INSERT INTO "Note" (id,"workspaceId",title,body,"plainText","contactId","dealId","authorId","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [t.noteId, t.workspaceId, `${name}_NOTE`, `${name}_NOTE_BODY`, `${name}_NOTE_BODY`, t.contactId, t.dealId, t.userId]);
      track("Note", t.noteId, name);

      await admin.query(
        `INSERT INTO "AuditLog" (id,"workspaceId","actorId",action,summary,"entityType","entityId")
         VALUES ($1,$2,$3,$4,$5,'Deal',$6)`,
        [t.auditId, t.workspaceId, t.userId, `${MARK.toLowerCase()}.seeded`, `${name}_AUDIT`, t.dealId]);
      track("AuditLog", t.auditId, name);

      await admin.query(
        `INSERT INTO "SecurityAlert" (id,"workspaceId","userId",kind,severity,summary,"dedupeKey")
         VALUES ($1,$2,$3,$4,'info',$5,$6)`,
        [t.alertId, t.workspaceId, t.userId, `${MARK.toLowerCase()}.marker`, `${name}_ALERT`, `${MARK}_${t.label}_${stamp}`]);
      track("SecurityAlert", t.alertId, name);
    }
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }

  const manifest = {
    mark: MARK,
    createdAt: new Date().toISOString(),
    tenants: { A: { ...A }, B: { ...B } },
    rows,
  };
  const fp = await fingerprintOf(admin, manifest);
  manifest.fingerprint = fp.hash;
  manifest.fingerprintLines = fp.lines;

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  chmodSync(MANIFEST, 0o600);
  await admin.end();

  console.log(`Fixture created. ${Object.values(rows).flat().length} rows across ${SHAPE.length} tables.`);
  console.log(`Workspace A : ${A.workspaceId}`);
  console.log(`Workspace B : ${B.workspaceId}`);
  console.log(`Fingerprint : ${fp.hash}`);
  console.log(`Manifest    : ${MANIFEST}`);
}

// ---------------------------------------------------------------------------

async function verify(url, ownerUrl, label) {
  const m = loadManifest();
  const app = await connect(url);
  // Two questions, two roles.
  //
  // "Is the data byte-identical?" is a content question, and asking it through
  // RLS measures visibility instead: the first run of this script fingerprinted
  // the source as owner and the target as the restricted role with no workspace
  // context set, so the hash differed for the one reason that has nothing to do
  // with the restore. Content is checked with full visibility.
  //
  // "Can A read B?" is an isolation question, and answering it with anything
  // other than the restricted role is worthless. That stays on `app`.
  const owner = ownerUrl ? await connect(ownerUrl) : null;
  const content = owner ?? app;

  head(`${label}: the connection under test`);
  const { rows: who } = await app.query(
    `SELECT current_user AS role, current_database() AS db,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
  const me = who[0];
  console.log(`  role=${me.role} database=${me.db} superuser=${me.super} bypassrls=${me.bypass}`);
  if (me.super || me.bypass) {
    console.error("\n  REFUSING TO CONTINUE: isolation asserted over a connection that bypasses RLS proves nothing.");
    await app.end();
    process.exit(2);
  }
  pass("the runtime role is not a superuser and does not bypass RLS");

  head(`${label}: row-level security`);
  const { rows: rls } = await app.query(`
    SELECT c.relname,
           c.relrowsecurity AS enabled,
           c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema='public' AND col.table_name=c.relname
                    AND col.column_name='workspaceId')
    ORDER BY c.relname`);
  const unprotected = rls.filter((r) => !r.enabled || !r.forced).map((r) => r.relname).sort();
  // One table carries a workspaceId and is deliberately not under RLS:
  // IdempotencyKey is written by the billing webhook, which is authenticated by
  // signature and has no workspace context to set, so a policy would refuse the
  // only write it ever receives. The reasoning is in
  // prisma/postgres/002_row_level_security.sql and docs/RLS.md, and its sole
  // writer sets scope/key/status/expiresAt only — never workspaceId, userId or
  // result — so there is no tenant data in it to isolate.
  //
  // Asserted as an exact set rather than skipped: a *newly* unprotected table
  // is a real defect, and a check that tolerates one exclusion by name would
  // wave through the next one.
  const EXPECTED_UNPROTECTED = ["IdempotencyKey"];
  const unexpected = unprotected.filter((t) => !EXPECTED_UNPROTECTED.includes(t));
  const nowProtected = EXPECTED_UNPROTECTED.filter((t) => !unprotected.includes(t));
  if (rls.length === 0) fail("workspace-owned tables were found", "none — the schema did not restore");
  else if (unexpected.length === 0) {
    pass(`RLS enabled AND forced on all ${rls.length - unprotected.length} workspace-owned tables`,
         `${EXPECTED_UNPROTECTED.length} documented exclusion${nowProtected.length ? `, ${nowProtected.join(", ")} now protected` : ""}`);
  } else {
    fail("RLS enabled and forced on every workspace-owned table",
         `undocumented and unprotected: ${unexpected.join(", ")}`);
  }

  head(`${label}: the fixture came back`);
  const fp = await fingerprintOf(content, m);
  let restored = 0, expected = 0;
  for (const [table] of SHAPE) {
    const ids = (m.rows[table] ?? []).map((r) => r.id);
    if (!ids.length) continue;
    expected += ids.length;
    // Counted once per table, not summed across both tenant contexts: tables
    // that are not workspace-scoped (User, PipelineStage) are visible under
    // either one, and summing reported 26 of 24 rows present.
    const { rows } = await content.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE id = ANY($1::text[])`, [ids]);
    restored += rows[0].n;
    if (rows[0].n !== ids.length) console.log(`    ${table}: ${rows[0].n}/${ids.length}`);
  }
  if (restored === expected) pass(`every fixture row is present (${restored}/${expected})`);
  else fail("every fixture row is present", `${restored}/${expected} — rows are missing`);

  head(`${label}: tenant isolation, asserted as ${me.role}`);
  const scopedCount = async (workspaceId, table, ids) => {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_ids', $1, true)", [workspaceId]);
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM "${table}" WHERE id = ANY($1::text[])`, [ids]);
    await app.query("ROLLBACK");
    return rows[0].n;
  };

  for (const [self, other] of [["A", "B"], ["B", "A"]]) {
    const me_ = m.tenants[self], them = m.tenants[other];
    // Positive and negative on the same table, in the same run. A refusal is
    // only evidence when the identical permitted read succeeds beside it.
    for (const table of ["Contact", "Company", "Deal", "Task", "Note", "AuditLog", "SecurityAlert"]) {
      const mine = (m.rows[table] ?? []).filter((r) => r.note === `${MARK}_${self}`).map((r) => r.id);
      const theirs = (m.rows[table] ?? []).filter((r) => r.note === `${MARK}_${other}`).map((r) => r.id);
      if (!mine.length || !theirs.length) continue;
      const own = await scopedCount(me_.workspaceId, table, mine);
      const cross = await scopedCount(me_.workspaceId, table, theirs);
      if (own === mine.length) pass(`${self}→${self} reads its own ${table}`);
      else fail(`${self}→${self} reads its own ${table}`, `got ${own}/${mine.length} — a refusal below would be meaningless`);
      if (cross === 0) pass(`${self}→${other} cannot read ${table}`);
      else fail(`${self}→${other} cannot read ${table}`, `CROSS-TENANT LEAK: ${cross} rows`);
    }
  }

  head(`${label}: referential integrity of the fixture`);
  await content.query("BEGIN");
  await content.query("SELECT set_config('app.workspace_ids', $1, true)",
    [`${m.tenants.A.workspaceId},${m.tenants.B.workspaceId}`]);
  const checks = [
    ["Deal.stageId resolves", `SELECT count(*)::int n FROM "Deal" d JOIN "PipelineStage" s ON s.id = d."stageId" WHERE d.id = ANY($1::text[])`, m.rows.Deal.map(r=>r.id)],
    ["Deal.companyId resolves", `SELECT count(*)::int n FROM "Deal" d JOIN "Company" c ON c.id = d."companyId" WHERE d.id = ANY($1::text[])`, m.rows.Deal.map(r=>r.id)],
    ["Contact.companyId resolves", `SELECT count(*)::int n FROM "Contact" ct JOIN "Company" c ON c.id = ct."companyId" WHERE ct.id = ANY($1::text[])`, m.rows.Contact.map(r=>r.id)],
    ["Company.primaryContactId resolves (the circular FK)", `SELECT count(*)::int n FROM "Company" c JOIN "Contact" ct ON ct.id = c."primaryContactId" WHERE c.id = ANY($1::text[])`, m.rows.Company.map(r=>r.id)],
    ["Note.dealId resolves", `SELECT count(*)::int n FROM "Note" nt JOIN "Deal" d ON d.id = nt."dealId" WHERE nt.id = ANY($1::text[])`, m.rows.Note.map(r=>r.id)],
    ["Task.contactId resolves", `SELECT count(*)::int n FROM "Task" tk JOIN "Contact" ct ON ct.id = tk."contactId" WHERE tk.id = ANY($1::text[])`, m.rows.Task.map(r=>r.id)],
  ];
  for (const [name, sql, ids] of checks) {
    const { rows } = await content.query(sql, [ids]);
    if (rows[0].n === ids.length) pass(name, `${rows[0].n}/${ids.length}`);
    else fail(name, `${rows[0].n}/${ids.length} — a relationship did not survive`);
  }
  await content.query("ROLLBACK");

  head(`${label}: fingerprint`);
  console.log(`  expected (source) : ${m.fingerprint}`);
  console.log(`  actual            : ${fp.hash}`);
  if (fp.hash === m.fingerprint) pass("the fingerprint matches the source recovery point exactly");
  else fail("the fingerprint matches the source recovery point", "the restored content differs");

  await app.end();
  if (owner) await owner.end();
  return { passed, failed };
}

// ---------------------------------------------------------------------------

async function cleanup() {
  const m = loadManifest();
  const keep = allIds(m);
  const admin = await connect(adminUrl());

  const target = process.env.PROBE_ADMIN_URL ? "the rehearsal cluster" : "production";
  head(`Guarded cleanup of ${target}`);
  console.log(`  the manifest records ${keep.size} ids; nothing outside that set can be deleted`);

  // Children before parents. Every delete is bounded by an explicit id list
  // taken from the manifest — never by the marker string, because a LIKE on a
  // name would delete anything a user happened to call RESTORE_PROBE.
  const order = ["SecurityAlert", "AuditLog", "Note", "Task", "Deal", "PipelineStage", "Pipeline", "Contact", "Company", "WorkspaceMember", "Workspace", "User"];
  let removed = 0;
  try {
    await admin.query("BEGIN");
    // Break the Company -> Contact cycle before deleting either.
    await admin.query(`UPDATE "Company" SET "primaryContactId" = NULL WHERE id = ANY($1::text[])`,
      [m.rows.Company.map((r) => r.id)]);
    for (const table of order) {
      const ids = (m.rows[table] ?? []).map((r) => r.id).filter((i) => keep.has(i));
      if (!ids.length) continue;
      const { rowCount } = await admin.query(`DELETE FROM "${table}" WHERE id = ANY($1::text[])`, [ids]);
      removed += rowCount;
      console.log(`  ${String(rowCount).padStart(3)} removed from ${table}`);
    }
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }

  // Prove nothing marked survived, and that the deletion was bounded.
  const { rows: left } = await admin.query(
    `SELECT count(*)::int n FROM "Workspace" WHERE name LIKE $1 OR slug LIKE $2`,
    [`${MARK}%`, `${MARK.toLowerCase()}%`]);
  if (left[0].n === 0) pass(`no ${MARK} workspace remains in ${target}`);
  else fail(`no ${MARK} workspace remains`, `${left[0].n} left behind`);
  console.log(`  ${removed} rows removed in total`);
  await admin.end();
}

// ---------------------------------------------------------------------------

const [command, arg] = process.argv.slice(2);
try {
  if (command === "seed") await seed();
  else if (command === "fingerprint") {
    const m = loadManifest();
    const c = await connect(arg || process.env.PROBE_ADMIN_URL || read("app-database.url"));
    const fp = await fingerprintOf(c, m);
    console.log(`fingerprint : ${fp.hash}`);
    console.log(`recorded    : ${m.fingerprint}`);
    console.log(fp.hash === m.fingerprint ? "MATCH" : "DIFFERENT");
    await c.end();
  }
  else if (command === "verify") await verify(arg || read("app-database.url"), process.argv[4] || process.env.PROBE_ADMIN_URL || (arg ? null : read("neon-owner.url")), arg ? "restored target" : "production");
  else if (command === "cleanup") await cleanup();
  else {
    console.error("Usage: restore-probe.mjs <seed|fingerprint|verify|cleanup> [APP_URL] [OWNER_URL]");
    process.exit(2);
  }
} catch (e) {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
}

if (passed || failed) {
  console.log(`\n${failed === 0 ? "PASSED" : "FAILED"} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
