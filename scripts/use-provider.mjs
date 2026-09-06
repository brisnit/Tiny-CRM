#!/usr/bin/env node
/**
 * Switches the Prisma datasource provider between sqlite and postgresql.
 *
 * The schema is written to be provider-agnostic (no native enums, no scalar
 * lists, no Json columns, money as integer cents), so this really is a one-word
 * change. The driver adapter in src/lib/db.ts picks itself from DATABASE_URL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

let target = process.argv[2];

/**
 * `auto` resolves the provider from DATABASE_URL.
 *
 * The committed schema says "sqlite", because that is what local development
 * uses. A deployment to PostgreSQL therefore starts from a checkout whose
 * datasource provider contradicts its own DATABASE_URL, and Prisma refuses:
 *
 *   The Driver Adapter `@prisma/adapter-pg` is not compatible with the
 *   provider `sqlite` specified in the Prisma schema.
 *
 * That failed the build on Vercel before a single page rendered. The build
 * command runs this with `auto` so the checkout is made self-consistent from
 * the connection string it was actually given, on any host, with no
 * platform-specific configuration.
 */
if (target === "auto") {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    console.error("DATABASE_URL is not set, so the provider cannot be resolved automatically.");
    process.exit(1);
  }
  target = /^postgres(ql)?:\/\//.test(url) ? "postgresql" : "sqlite";
  console.log(`Resolved provider "${target}" from DATABASE_URL.`);
}

if (!["sqlite", "postgresql"].includes(target)) {
  console.error("Usage: node scripts/use-provider.mjs <sqlite|postgresql|auto>");
  process.exit(1);
}

const path = resolve(process.cwd(), "prisma/schema.prisma");
const schema = readFileSync(path, "utf8");
const updated = schema.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"(sqlite|postgresql)"/s,
  `$1"${target}"`,
);

if (updated === schema) {
  console.log(`Provider is already "${target}".`);
} else {
  writeFileSync(path, updated);
  console.log(`Datasource provider set to "${target}".`);
}

console.log(
  target === "postgresql"
    ? "\nNext steps:\n  1. Set DATABASE_URL to your postgres:// connection string\n  2. npx prisma migrate dev --name init-postgres\n  3. npm run db:seed\n"
    : "\nNext steps:\n  1. Set DATABASE_URL=\"file:./dev.db\"\n  2. npx prisma migrate dev\n",
);
