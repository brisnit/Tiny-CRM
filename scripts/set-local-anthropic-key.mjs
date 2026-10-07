#!/usr/bin/env node
/**
 * Writes ANTHROPIC_API_KEY into `.env` from a hidden prompt, then proves it works.
 *
 * ## Why this exists rather than "edit line 14"
 *
 * Editing it by hand failed twice, silently and in the same way: the value on
 * disk ended up 31 characters long when a key is about 108, which is what a
 * paste that started mid-string looks like. Nothing reported it — the app
 * simply resolved to the built-in engine, and the only symptom was a 401 from a
 * check nobody had run yet.
 *
 * So this validates *before* writing and verifies *after*. A value that is not
 * a plausible key never reaches the file, and a key that does not authenticate
 * is reported immediately rather than discovered later.
 *
 * ## How the secret is handled
 *
 *   - Read from a hidden prompt — the same `promptHidden` the production
 *     migration script uses. Never argv, which is visible in `ps`, and never a
 *     shell command, which lands in history.
 *   - Written only to `.env`, which is git-ignored and untracked. Both are
 *     asserted rather than assumed, because the cost of being wrong is a
 *     published secret.
 *   - Never printed and never logged. Failures report lengths and prefixes.
 *
 *   node scripts/set-local-anthropic-key.mjs
 *
 * `--check` verifies what is already there and writes nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(ROOT, ".env");
const VARIABLE = "ANTHROPIC_API_KEY";

/** Shortest value worth sending to the API. Real keys are around 108. */
const MIN_PLAUSIBLE_LENGTH = 60;

function readCurrent() {
  if (!existsSync(ENV_PATH)) return null;
  const line = readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .find((l) => new RegExp(`^\\s*(?:export\\s+)?${VARIABLE}\\s*=`).test(l));
  if (!line) return null;
  const raw = line.slice(line.indexOf("=") + 1).trim();
  return raw.replace(/^(['"])(.*)\1$/, "$2");
}

async function authenticates(key) {
  const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (response.ok) return { ok: true };
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message ?? "";
  } catch {
    detail = "";
  }
  return { ok: false, status: response.status, detail };
}

/** Lengths and shape only — never the value. */
function describe(key) {
  const prefix = key.startsWith("sk-ant-")
    ? "starts with sk-ant-"
    : `starts with ${JSON.stringify(key.slice(0, 3))}`;
  return `${key.length} characters, ${prefix}`;
}

function assertSafeToWrite() {
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: ROOT });
  } catch {
    throw new Error(".env is NOT git-ignored. Refusing to write a secret into it.");
  }
  let tracked = false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: ROOT, stdio: "ignore" });
    tracked = true;
  } catch {
    tracked = false;
  }
  if (tracked) throw new Error(".env is TRACKED by git. Refusing to write a secret into it.");
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  assertSafeToWrite();

  const current = readCurrent();
  const state =
    current === null ? "absent" : current.length === 0 ? "empty" : describe(current);
  console.log(`\n${VARIABLE} in .env: ${state}`);

  if (checkOnly) {
    if (!current) {
      console.log("Nothing to check.\n");
      process.exit(1);
    }
    const result = await authenticates(current);
    console.log(
      result.ok
        ? "  authenticates: YES\n"
        : `  authenticates: NO — HTTP ${result.status} ${result.detail}\n`,
    );
    process.exit(result.ok ? 0 : 1);
  }

  const key = await promptHidden("\nPaste the full key (input hidden, then Enter): ");

  // Validated before it touches the file. A truncated paste is the failure this
  // script exists for, so it must not be the thing that gets written.
  if (key.length < MIN_PLAUSIBLE_LENGTH) {
    throw new Error(
      `That is ${key.length} characters. A key is around 108, so this looks like a partial ` +
        `paste — .env has NOT been changed. Copy the whole value, including the sk-ant- prefix.`,
    );
  }
  if (!key.startsWith("sk-ant-")) {
    throw new Error(
      `That starts with ${JSON.stringify(key.slice(0, 3))} rather than "sk-ant-", so the ` +
        `beginning is missing — .env has NOT been changed.`,
    );
  }
  if (/\s/.test(key)) {
    throw new Error("That contains whitespace — .env has NOT been changed.");
  }

  console.log(`\n  received ${describe(key)}`);
  console.log("  checking it against the API before writing…");
  const result = await authenticates(key);
  if (!result.ok) {
    throw new Error(
      `HTTP ${result.status}${result.detail ? `: ${result.detail}` : ""}. ` +
        `.env has NOT been changed.`,
    );
  }
  console.log("  authenticates: YES");

  const contents = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?${VARIABLE}\\s*=).*$`, "m");
  const updated = pattern.test(contents)
    ? contents.replace(pattern, `$1"${key}"`)
    : `${contents.replace(/\n*$/, "\n")}${VARIABLE}="${key}"\n`;
  writeFileSync(ENV_PATH, updated, { mode: 0o600 });

  const written = readCurrent();
  if (written !== key) {
    throw new Error("What was written back does not match what was entered. Check .env by hand.");
  }
  console.log(`\n  written to .env and read back identical (${written.length} characters)`);
  console.log("  permissions set to 600\n");
  console.log("Next: node scripts/docqa-model-check.mjs\n");
}

main().catch((error) => {
  // Scrub anything key-shaped, in case a message ever carries one.
  console.error(`\n${String(error?.message ?? error).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")}\n`);
  process.exit(1);
});
