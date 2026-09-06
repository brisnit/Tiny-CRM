#!/usr/bin/env node
/**
 * Dependency risk, with evidence rather than a label.
 *
 * `npm audit` reports advisories against the whole dependency graph, including
 * build-time tools that never ship. The previous pass asserted that the four
 * high advisories were "transitive under the Prisma CLI and not in the deployed
 * runtime". This checks that claim three ways instead of repeating it:
 *
 *   1. Which advisories exist, and whether each package is a production
 *      dependency or only reachable through devDependencies.
 *   2. Whether the vulnerable package appears in the **production** install
 *      tree (`npm ls --omit=dev`).
 *   3. Whether it appears in the **built output** — the files that actually run
 *      in production.
 *
 * The third is the one that matters. A package can be a production dependency
 * and still be tree-shaken out, and a devDependency can be inlined by a bundler.
 * Only the build output settles it.
 *
 *   npm run audit:deps
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function npm(args) {
  try {
    return execFileSync("npm", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // `npm audit` and `npm ls` exit non-zero when they find something; the
    // output on stdout is still what we want.
    return error.stdout ?? "";
  }
}

console.log("Dependency risk\n" + "=".repeat(64));

// ---------------------------------------------------------------------------
// 1. The advisories
// ---------------------------------------------------------------------------
const audit = JSON.parse(npm(["audit", "--json"]) || "{}");
const vulnerabilities = Object.values(audit.vulnerabilities ?? {});

if (vulnerabilities.length === 0) {
  console.log("\nnpm audit reports no advisories.");
}

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const productionDeps = new Set(Object.keys(manifest.dependencies ?? {}));
const devDeps = new Set(Object.keys(manifest.devDependencies ?? {}));

console.log(`\n[1] ${vulnerabilities.length} advisor${vulnerabilities.length === 1 ? "y" : "ies"}\n`);
for (const v of vulnerabilities) {
  const roots = (v.effects ?? []).length ? v.effects.join(", ") : "(direct)";
  const classification = productionDeps.has(v.name)
    ? "PRODUCTION DEPENDENCY"
    : devDeps.has(v.name)
      ? "devDependency (direct)"
      : "transitive";
  console.log(`  ${v.severity.padEnd(8)} ${v.name.padEnd(22)} ${classification}`);
  console.log(`           reached through: ${roots}`);
  const titles = (v.via ?? []).filter((x) => typeof x === "object").map((x) => x.title);
  for (const title of titles) console.log(`           ${title}`);
  if (v.fixAvailable === false) console.log("           no fix available upstream");
  else if (typeof v.fixAvailable === "object") {
    console.log(`           fix: ${v.fixAvailable.name}@${v.fixAvailable.version}` +
      `${v.fixAvailable.isSemVerMajor ? " (breaking)" : ""}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 2. The production install tree
// ---------------------------------------------------------------------------
console.log("[2] Installed by a production install (npm ls --omit=dev)\n");
const names = [...new Set(vulnerabilities.map((v) => v.name))];
const productionTree = {};
for (const name of names) {
  const output = npm(["ls", name, "--omit=dev", "--json"]);
  let present = false;
  let path = "";
  try {
    const parsed = JSON.parse(output || "{}");
    // Walk the tree so the *route* is reported, not just a substring hit. The
    // route is the interesting part: it says which production dependency drags
    // the package in.
    const find = (node, trail) => {
      for (const [child, info] of Object.entries(node.dependencies ?? {})) {
        if (child === name) {
          present = true;
          path = [...trail, child].join(" -> ");
          return;
        }
        find(info, [...trail, child]);
        if (present) return;
      }
    };
    find(parsed, []);
  } catch {
    present = false;
  }
  productionTree[name] = present;
  console.log(`  ${present ? "INSTALLED" : "absent   "}  ${name}${path ? `  (${path})` : ""}`);
}

// ---------------------------------------------------------------------------
// 3. The built output
// ---------------------------------------------------------------------------
console.log("\n[3] Loaded at runtime — present in the build output (.next)\n");

const bundledPackages = new Set();
const BUILD = join(ROOT, ".next");
if (!existsSync(BUILD)) {
  console.log("  .next does not exist. Run `npm run build` first for this check.");
} else {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const info = statSync(path);
      if (info.isDirectory()) {
        if (entry === "cache" || entry === "dev") continue;
        walk(path);
      } else if (/\.(js|mjs|cjs|json)$/.test(entry)) {
        files.push(path);
      }
    }
  };
  walk(BUILD);

  console.log(`  Scanned ${files.length} built files.\n`);
  for (const name of names) {
    // Recorded for the summary below.
    // Look for the package's own module path, not the bare name: "mysql2"
    // appears in a comment or a string far more often than it is actually
    // bundled.
    const needle = `node_modules/${name}/`;
    const hits = files.filter((file) => {
      try {
        return readFileSync(file, "utf8").includes(needle);
      } catch {
        return false;
      }
    });
    if (hits.length > 0) bundledPackages.add(name);
    console.log(`  ${hits.length === 0 ? "absent " : "LOADED "}  ${name}` +
      (hits.length ? `  (${hits.length} file(s), e.g. ${hits[0].slice(ROOT.length + 1)})` : ""));
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(64));

const installed = names.filter((n) => productionTree[n]);
const bundled = names.filter((n) => bundledPackages.has(n));

console.log(
  "\nTwo different questions, and the previous hardening report conflated them:\n\n" +
    "  INSTALLED  the package is on disk after `npm ci --omit=dev`. It is in the\n" +
    "             container image, and anything that requires it would load it.\n" +
    "  LOADED     the package appears in the build output, so the running server\n" +
    "             actually executes it.\n",
);

if (installed.length > 0) {
  console.log(
    `INSTALLED in a production install: ${installed.join(", ")}\n` +
      "  These ship on disk. Reducing that means removing whatever pulls them in.\n",
  );
}

if (bundled.length > 0) {
  console.log(
    `LOADED at runtime: ${bundled.join(", ")}\n` +
      "  These execute in production and the advisories apply directly.\n",
  );
  process.exitCode = 1;
} else if (names.length > 0) {
  console.log(
    "LOADED at runtime: none.\n" +
      "  No package with an open advisory appears in the build output, so none is\n" +
      "  executed by the running application. They remain on disk.\n",
  );
}
