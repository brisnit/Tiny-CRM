/**
 * Refuses to seed a database that looks real.
 *
 * Two profiles, because the two seeds carry different hazards:
 *
 *  - **destructive** (`prisma/seed/index.ts`) deletes every row and creates
 *    accounts with a password published in the README. Running it against a
 *    customer database destroys their data *and* leaves a credentialed back
 *    door. It is refused on any non-SQLite database and on production.
 *
 *  - **verification** (`prisma/seed/test-seed.ts`) is additive and generates a
 *    random password per run that it never prints. Its only hazard is junk rows,
 *    so it is refused on production but allowed on PostgreSQL — verifying
 *    against PostgreSQL is the entire reason it exists.
 *
 * Both checks run at module scope, before a Prisma client is constructed. A
 * guard inside `main()` never executes: connecting to the wrong database fails
 * during import, which is an accident rather than a control.
 *
 * `SEED_ALLOW_PRODUCTION` is the deliberate override, and the production startup
 * gate refuses to boot a server that has it set — so a database seeded this way
 * cannot then quietly serve traffic.
 */

export type SeedProfile = "destructive" | "verification";

export function assertSafeToSeed(profile: SeedProfile): void {
  if (process.env.SEED_ALLOW_PRODUCTION === "true") {
    console.warn(
      "\nSEED_ALLOW_PRODUCTION is set. Seeding a non-development database on purpose.\n" +
        (profile === "destructive"
          ? "Every row will be deleted and demo accounts with a published password created.\n"
          : "Verification data will be added to this database.\n"),
    );
    return;
  }

  const url = process.env.DATABASE_URL ?? "";
  const problems: string[] = [];

  if (process.env.NODE_ENV === "production") {
    problems.push("NODE_ENV is production");
  }
  if (profile === "destructive" && url && !url.startsWith("file:")) {
    // Only the host is echoed back — never the credentials in the URL.
    problems.push(`DATABASE_URL is not a local SQLite file (…@${url.split("@").pop()})`);
  }

  if (problems.length === 0) return;

  console.error(
    "\nRefusing to seed: this looks like a real database.\n\n" +
      problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
      (profile === "destructive"
        ? "\n\nThis script deletes every row and creates accounts with a published\npassword."
        : "\n\nThis script writes verification records.") +
      " If you genuinely mean to do that, set SEED_ALLOW_PRODUCTION=true.\n" +
      "See docs/DEPLOYMENT-CHECKLIST.md.\n",
  );
  process.exit(1);
}
