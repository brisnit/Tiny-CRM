#!/usr/bin/env node
/**
 * The set of suites that run against a database engine, in one place.
 *
 * This exists because the pattern was written out three times — twice in the
 * runner scripts and once inline in the PostgreSQL CI job — and the copies
 * drifted the moment tests/browser was added: the runners skipped it, the
 * workflow did not, and the PostgreSQL jobs tried to drive a browser with no
 * application running.
 *
 * The drift was survivable. The failure mode underneath it is not: `node --test`
 * exits **0** when its pattern matches nothing, so a typo here would turn every
 * database job green while running no tests at all. Hence `--check`, which is a
 * CI step: it fails unless the pattern accounts for every test file in the
 * repository.
 */
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * tests/browser is excluded deliberately: those suites need the application
 * running and a Chromium to drive it, which `npm run test:browser` and the
 * `browser` CI job set up. Nothing in them depends on the database engine.
 */
export const ENGINE_SUITE_DIRECTORIES = ["unit", "integration", "security", "portability"];
export const EXCLUDED_DIRECTORIES = ["browser", "helpers"];
export const ENGINE_SUITE_GLOB = `tests/{${ENGINE_SUITE_DIRECTORIES.join(",")}}/**/*.test.ts`;

function testFilesUnder(directory) {
  const root = resolve(process.cwd(), directory);
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      const full = resolve(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".test.ts")) found.push(full);
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return found;
}

// `--glob` lets the workflow use this pattern without restating it in YAML.
if (process.argv[2] === "--glob") {
  process.stdout.write(ENGINE_SUITE_GLOB);
  process.exit(0);
}

if (process.argv[2] === "--check") {
  const everything = testFilesUnder("tests");
  const covered = ENGINE_SUITE_DIRECTORIES.flatMap((d) => testFilesUnder(`tests/${d}`));
  const excluded = EXCLUDED_DIRECTORIES.flatMap((d) => testFilesUnder(`tests/${d}`));
  const unaccounted = everything.filter((f) => !covered.includes(f) && !excluded.includes(f));

  const problems = [];
  if (covered.length === 0) {
    problems.push("the engine pattern matches no test files at all");
  }
  for (const directory of ENGINE_SUITE_DIRECTORIES) {
    if (testFilesUnder(`tests/${directory}`).length === 0) {
      problems.push(`tests/${directory} has no test files — has it been renamed?`);
    }
  }
  for (const file of unaccounted) {
    problems.push(`${file.replace(process.cwd() + "/", "")} is in no suite — it will never run`);
  }

  if (problems.length > 0) {
    console.error("Test discovery is broken:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(
    `Test discovery is intact: ${covered.length} engine test files, ` +
      `${excluded.length} excluded by design.`,
  );
}
