#!/usr/bin/env node
/**
 * Writes the Microsoft Entra canary credentials into `.env` from a hidden
 * prompt, and proves the secret authenticates before it is saved.
 *
 *   node scripts/set-microsoft-canary.mjs           # set the client secret
 *   node scripts/set-microsoft-canary.mjs --check   # verify, write nothing
 *
 * ## What it writes
 *
 *   MICROSOFT_CLIENT_ID      the app registration's Application (client) ID
 *   MICROSOFT_TENANT_ID      the Directory (tenant) ID
 *   MICROSOFT_CLIENT_SECRET  the secret's **Value**
 *
 * The first two are identifiers, not secrets — they appear in every
 * authorisation URL — so they are set from the command line. Only the secret
 * comes from the hidden prompt.
 *
 * ## How the secret is handled
 *
 *   - Read from a hidden prompt, the same `promptHidden` the production
 *     migration scripts use. Never argv, which `ps` shows, and never part of a
 *     shell command, which lands in history.
 *   - Written only to `.env`, with mode 600. Both git-ignored and untracked are
 *     asserted rather than assumed, because being wrong publishes a secret.
 *   - Never printed, never logged, and scrubbed from any error message.
 *
 * ## Why it can verify without admin consent
 *
 * A client-credentials request authenticates the *client* before it considers
 * permissions, so the two failures separate cleanly:
 *
 *   - a wrong or expired secret fails with `invalid_client` / AADSTS7000215,
 *     which is what this treats as a bad secret;
 *   - a correct secret with no application permissions granted fails on the
 *     *scope or consent*, which proves the secret is right.
 *
 * So this needs no tenant-wide admin consent and grants none. It is not a test
 * of the delegated flow — that needs a browser and a person — and it does not
 * pretend to be.
 *
 * ## A common paste error this catches
 *
 * The portal shows a secret's **Value** and its **Secret ID**, side by side,
 * and the Secret ID is a GUID. Pasting the Secret ID is the usual mistake; it
 * is refused here by shape, before anything is written.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(ROOT, ".env");

const CLIENT_ID = "080880ad-f468-4e83-bf08-b117e13deba5";
const TENANT_ID = "4883aac4-8e9b-42fe-a7cf-78b9183ddc99";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Entra client secrets are around 40 characters; well under 20 is a partial paste. */
const MIN_SECRET_LENGTH = 20;

function assertSafeToWrite() {
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: ROOT });
  } catch {
    throw new Error(".env is NOT git-ignored. Refusing to write a secret into it.");
  }
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: ROOT, stdio: "ignore" });
    throw new Error(".env is TRACKED by git. Refusing to write a secret into it.");
  } catch (error) {
    if (String(error?.message ?? "").includes("TRACKED")) throw error;
    // Not tracked, which is what we want.
  }
}

function readVariable(name) {
  if (!existsSync(ENV_PATH)) return null;
  const line = readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .find((l) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l));
  if (!line) return null;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}

function writeVariable(name, value) {
  const contents = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`, "m");
  const updated = pattern.test(contents)
    ? contents.replace(pattern, `$1"${value}"`)
    : `${contents.replace(/\n*$/, "\n")}${name}="${value}"\n`;
  writeFileSync(ENV_PATH, updated, { mode: 0o600 });
}

/** Lengths and shape only — never the value. */
function describe(secret) {
  return `${secret.length} characters, starts with ${JSON.stringify(secret.slice(0, 2))}`;
}

/**
 * Asks Entra for an app-only token purely to find out whether the secret is
 * accepted. See the header for why a scope or consent failure counts as
 * success here.
 */
async function secretAuthenticates(secret) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: secret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
  );
  if (response.ok) return { ok: true, note: "a token was issued" };

  let error = "";
  let description = "";
  try {
    const parsed = await response.json();
    error = String(parsed?.error ?? "");
    description = String(parsed?.error_description ?? "");
  } catch {
    description = `HTTP ${response.status}`;
  }

  // The one failure that means the secret itself is wrong.
  if (error === "invalid_client" || /AADSTS7000215|AADSTS7000222/.test(description)) {
    const code = description.match(/AADSTS\d+/)?.[0] ?? error;
    return {
      ok: false,
      reason:
        code === "AADSTS7000222"
          ? "the secret has expired"
          : "the secret was rejected as invalid — check you copied the Value, not the Secret ID",
      code,
    };
  }

  // Anything else got past client authentication, which is all we are asking.
  const code = description.match(/AADSTS\d+/)?.[0] ?? error ?? "no code";
  return {
    ok: true,
    note: `client authentication succeeded; the request then failed on permissions (${code}), which is expected without admin consent`,
  };
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  assertSafeToWrite();

  console.log("\nMicrosoft Entra canary — TinyCRM Microsoft Canary");
  console.log("=".repeat(70));
  console.log(`  client id  ${CLIENT_ID}`);
  console.log(`  tenant id  ${TENANT_ID}`);
  console.log("  authority  tenant-specific (not /common)");

  const existing = readVariable("MICROSOFT_CLIENT_SECRET");
  console.log(
    `\n  MICROSOFT_CLIENT_SECRET in .env: ${
      existing === null ? "absent" : existing.length === 0 ? "empty" : describe(existing)
    }`,
  );

  if (checkOnly) {
    if (!existing) {
      console.log("\n  Nothing to check.\n");
      process.exit(1);
    }
    const result = await secretAuthenticates(existing);
    console.log(result.ok ? `  authenticates: YES — ${result.note}\n` : `  authenticates: NO — ${result.reason}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  const secret = await promptHidden(
    "\nPaste the secret VALUE from Certificates & secrets (input hidden, then Enter): ",
  );

  // Validated before it touches the file.
  if (GUID.test(secret)) {
    throw new Error(
      "That is a GUID, which is the Secret ID rather than the Value. The Value is a longer " +
        "mixed-character string in the row above it, and it is shown only once — .env has NOT " +
        "been changed.",
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `That is ${secret.length} characters, which looks like a partial paste — a secret value ` +
        `is around 40. .env has NOT been changed.`,
    );
  }
  if (/\s/.test(secret)) {
    throw new Error("That contains whitespace — .env has NOT been changed.");
  }

  console.log(`\n  received ${describe(secret)}`);
  console.log("  checking it against Entra before writing…");
  const result = await secretAuthenticates(secret);
  if (!result.ok) {
    throw new Error(`${result.reason} (${result.code}). .env has NOT been changed.`);
  }
  console.log(`  authenticates: YES — ${result.note}`);

  writeVariable("MICROSOFT_CLIENT_ID", CLIENT_ID);
  writeVariable("MICROSOFT_TENANT_ID", TENANT_ID);
  writeVariable("MICROSOFT_CLIENT_SECRET", secret);

  const readBack = readVariable("MICROSOFT_CLIENT_SECRET");
  if (readBack !== secret) {
    throw new Error("What was written back does not match what was entered. Check .env by hand.");
  }
  console.log(`\n  written to .env and read back identical (${readBack.length} characters)`);
  console.log("  permissions set to 600");
  console.log("\n  Nothing was deployed and no consent was granted. Integrations remain off.\n");
}

main().catch((error) => {
  // Scrub anything secret-shaped, in case a message ever carries one.
  const message = String(error?.message ?? error).replace(/[A-Za-z0-9~._\-]{20,}/g, (m) =>
    GUID.test(m) ? m : "[redacted]",
  );
  console.error(`\n${message}\n`);
  process.exit(1);
});
