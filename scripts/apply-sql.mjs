#!/usr/bin/env node
/**
 * Applies a .sql file to the database in DATABASE_URL.
 *
 * A stand-in for `psql -f`: the embedded PostgreSQL builds ship no psql, and
 * CI uses the real one. Statements are sent individually rather than as one
 * batch, because `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
 * and node-postgres wraps a multi-statement query in one implicitly.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/apply-sql.mjs <file.sql>");
  process.exit(1);
}

const sql = readFileSync(file, "utf8");

/**
 * Splits a script into statements, respecting dollar quoting.
 *
 * A naive split on `;` shreds a `DO $$ … END $$;` block, because the body
 * contains statement terminators of its own — the first version of this script
 * did exactly that and hung. Line comments and string literals are skipped for
 * the same reason.
 */
function splitStatements(text) {
  const statements = [];
  let current = "";
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);

    // Line comment
    if (rest.startsWith("--")) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
      current += "\n";
      continue;
    }

    // Block comment
    if (rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    // Single-quoted string
    if (text[i] === "'") {
      const match = /^'(?:[^']|'')*'/.exec(rest);
      const literal = match ? match[0] : rest;
      current += literal;
      i += literal.length;
      continue;
    }

    // Dollar-quoted block: $$ … $$ or $tag$ … $tag$
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = text.indexOf(tag, i + tag.length);
      const block = end === -1 ? rest : text.slice(i, end + tag.length);
      current += block;
      i += block.length;
      continue;
    }

    if (text[i] === ";") {
      statements.push(current.trim());
      current = "";
      i++;
      continue;
    }

    current += text[i];
    i++;
  }

  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => s.length > 0);
}

const statements = splitStatements(sql);

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let applied = 0;
for (const statement of statements) {
  try {
    await client.query(statement);
    applied++;
  } catch (error) {
    console.error(`\nFailed: ${statement.slice(0, 120)}…\n  ${error.message}`);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(`Applied ${applied} statement(s) from ${file}`);
