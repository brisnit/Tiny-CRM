/**
 * The production readiness check for the customer notice. Sends nothing.
 *
 *   NODE_OPTIONS="--require ./scripts/allow-server-modules.cjs" \
 *     npx tsx scripts/preflight-notice.ts \
 *       --audience=recipient-snapshot.json \
 *       --from='Tiny CRM <no-reply@tinycrm.biz>'
 *
 * It prompts for the production database URL and the mail provider token
 * with hidden input. Neither is ever an argument, written to disk, echoed,
 * or included in any output — the report names the database by fingerprint
 * and the token by presence only.
 *
 * ## Why it prompts rather than reading the environment
 *
 * `vercel env run -e production` does NOT supply usable values here. Run
 * against this project it loads the local `.env` files and hands the
 * process empty strings for `MAIL_PROVIDER_URL`, `MAIL_PROVIDER_TOKEN`,
 * `MAIL_FROM` and `CRON_SECRET`, while `DATABASE_URL` arrives as the local
 * SQLite file from `.env`. A send run that way would quietly target the
 * development database through the development sink. Measured, not assumed.
 *
 * The other supported route, `vercel env pull`, writes every production
 * secret to disk to obtain two of them. Prompting is the pattern the rest
 * of this directory already uses and keeps the credentials in one process.
 *
 * ## What it refuses
 *
 * A check that passes against the wrong database or a fake mail adapter is
 * worse than no check, because it is reported as a pass. So:
 *
 *   - a database that is not a known production fingerprint
 *   - a configuration that would not select the real mail provider
 *   - an audience file that does not match the accounts it finds
 *
 * each end the run with a non-zero exit and nothing sent.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { adapterKindFor } from "../src/lib/mail";

import { fingerprint, identifyDatabase } from "./lib/db-fingerprint.mjs";
import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as typeof import("pg");

/** Resend's endpoint. Not a secret, and not prompted for. */
const DEFAULT_MAIL_URL = "https://api.resend.com/emails";


const idOf = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const problems: string[] = [];
const refuse = (why: string) => problems.push(why);

async function main() {
  console.log("\nNotice preflight — production readiness, zero sends");
  console.log("=".repeat(70));

  const audiencePath = arg("audience");
  const from = arg("from");
  const mailUrl = arg("mail-url") ?? DEFAULT_MAIL_URL;

  if (!audiencePath) {
    console.error("\n--audience=<snapshot.json> is required. This check exists to compare a");
    console.error("real database against an approved list; without one there is nothing to\n" +
      "check it against.\n");
    process.exit(1);
  }
  if (!from) {
    console.error("\n--from='Name <address>' is required: it is the sender the send will use.\n");
    process.exit(1);
  }

  // ---- The approved audience -------------------------------------------
  let audience: { takenAt?: string; recipients?: { id: string; masked: string }[] };
  try {
    audience = JSON.parse(readFileSync(audiencePath, "utf8"));
  } catch (error) {
    console.error(`\nCould not read ${audiencePath}: ${(error as Error).message}`);
    console.error("Refusing: an unreadable audience is not an empty one.\n");
    process.exit(1);
  }
  const approved = new Map((audience.recipients ?? []).map((r) => [r.id, r]));
  if (approved.size === 0) {
    console.error(`\n${audiencePath} lists no recipients. Refusing.\n`);
    process.exit(1);
  }

  // ---- Credentials, in this process only -------------------------------
  // Rehearsal hooks, so every refusal path can be exercised without a person
  // typing at a prompt. Never set in normal use; the prompt is the path.
  const dbUrl =
    process.env.PREFLIGHT_DB_FOR_REHEARSAL
    ?? (await promptHidden("Production database URL (input hidden): "));
  const mailToken =
    process.env.PREFLIGHT_TOKEN_FOR_REHEARSAL
    ?? (await promptHidden("Mail provider token (input hidden): "));

  let fp: string;
  try {
    fp = fingerprint(dbUrl);
  } catch {
    console.error("\nThat is not a parseable connection string. Nothing was read.\n");
    process.exit(1);
  }
  const known = identifyDatabase(dbUrl);

  console.log(`\n  audience file     ${audiencePath}`);
  console.log(`  approved on       ${audience.takenAt ?? "an unrecorded date"}`);
  console.log(`  approved count    ${approved.size}`);
  console.log(`\n  database target   ${known ?? "UNRECOGNISED"}   (fingerprint ${fp})`);

  if (!known) {
    refuse(
      "the database is not a known production endpoint. A preflight that passes " +
        "against a local or staging database is a pass for the wrong system.",
    );
  }
  if (/^file:/i.test(dbUrl) || /localhost|127\.0\.0\.1/.test(dbUrl)) {
    refuse("the database URL is local. This check is only meaningful against production.");
  }

  // ---- The mail adapter, by the real rule ------------------------------
  const kind = adapterKindFor(mailUrl, mailToken || undefined, { production: true });
  console.log(`  mail adapter      ${kind}${kind === "http" ? "   (real provider)" : "   NOT THE REAL PROVIDER"}`);
  console.log(`  sender            ${from}`);
  console.log(`  provider endpoint ${mailUrl}`);
  console.log(`  provider token    ${mailToken ? "present, non-empty" : "MISSING"}`);
  if (kind !== "http") {
    refuse(`the configuration selects the ${kind} adapter, so a send would not reach anyone.`);
  }
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>\s*$/.test(from)) {
    refuse(`the sender ${JSON.stringify(from)} is not an address or "Name <address>".`);
  }

  // ---- The accounts, read but never written ----------------------------
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 20_000 });
  await client.connect();
  let matched: string[] = [];
  let missing: { id: string; masked: string }[] = [];
  let unapproved = 0;
  try {
    const { rows } = await client.query<{ email: string }>(
      `SELECT lower("email") AS email FROM "User" ORDER BY "createdAt" ASC`,
    );
    const emails = rows
      .map((r) => r.email?.trim().toLowerCase())
      .filter((e): e is string => !!e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    const byId = new Map(emails.map((e) => [idOf(e), e]));

    matched = emails.filter((e) => approved.has(idOf(e)));
    missing = [...approved.entries()].filter(([id]) => !byId.has(id)).map(([, r]) => r);
    unapproved = emails.length - matched.length;

    console.log(`\n  accounts in database   ${emails.length}`);
    console.log(`  matched the audience   ${matched.length}`);
    console.log(`  not approved, excluded ${unapproved}`);
    console.log(`  approved but missing   ${missing.length}`);
    for (const r of missing) console.log(`      ${r.masked}   cannot be sent to`);
  } finally {
    await client.end();
  }

  if (matched.length !== approved.size) {
    refuse(
      `audience mismatch: ${approved.size} approved, ${matched.length} found. ` +
        "Re-run the recipient review and re-approve before sending.",
    );
  }

  console.log("\n  messages sent     0   (this command has no send path)");

  console.log("\n" + "=".repeat(70));
  if (problems.length === 0) {
    console.log(`  READY. ${matched.length} approved recipients, real provider, production`);
    console.log("  database. Nothing was sent and nothing was written.\n");
    process.exit(0);
  }
  console.log(`  NOT READY — ${problems.length} problem(s). Nothing was sent:`);
  for (const p of problems) console.log(`    - ${p}`);
  console.log("");
  process.exit(1);
}

main().catch((error) => {
  // A connection error can quote the URL, credentials and all.
  const message = String(error?.message ?? error)
    .replace(/postgres(ql)?:\/\/[^\s]*/gi, "[connection string redacted]")
    .replace(/\bre_[A-Za-z0-9_-]{8,}/g, "[token redacted]");
  console.error(`\n${message}\n`);
  process.exit(2);
});
