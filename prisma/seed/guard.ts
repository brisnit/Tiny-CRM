/**
 * Refuses to seed a real database.
 *
 * The seed script begins by **deleting every row** and then creates known
 * accounts with a password published in the README. Running it against
 * production would destroy customer data and leave a credentialed back door.
 *
 * This runs at module scope and is imported first, before the Prisma client is
 * constructed — a guard inside `main()` never executes, because connecting to
 * the wrong database fails during import, which is an accident rather than a
 * control.
 *
 * Two independent signals are checked, because either one alone can be wrong: a
 * cron can forget `NODE_ENV`, and a staging box can legitimately point at
 * PostgreSQL. `SEED_ALLOW_PRODUCTION` is the deliberate override, and the
 * production startup gate refuses to boot a server that has it set — so a
 * database seeded this way cannot then quietly serve traffic.
 */

const url = process.env.DATABASE_URL ?? "";

if (process.env.SEED_ALLOW_PRODUCTION === "true") {
  console.warn(
    "\nSEED_ALLOW_PRODUCTION is set. Seeding a non-development database on purpose.\n" +
      "Every row will be deleted and demo accounts with a published password created.\n",
  );
} else {
  const problems: string[] = [];

  if (process.env.NODE_ENV === "production") {
    problems.push("NODE_ENV is production");
  }
  if (url && !url.startsWith("file:")) {
    // Only the host is echoed back — never the credentials in the URL.
    problems.push(`DATABASE_URL is not a local SQLite file (…@${url.split("@").pop()})`);
  }

  if (problems.length > 0) {
    console.error(
      "\nRefusing to seed: this looks like a real database.\n\n" +
        problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
        "\n\nThis script deletes every row and creates accounts with a published\n" +
        "password. If you genuinely mean to do that, set SEED_ALLOW_PRODUCTION=true.\n" +
        "See docs/DEPLOYMENT-CHECKLIST.md.\n",
    );
    process.exit(1);
  }
}
