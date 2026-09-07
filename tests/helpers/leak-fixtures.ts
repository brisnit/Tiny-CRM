/**
 * One realistic error carrying every category of secret this application holds.
 *
 * Shared so the scrubbing tests and the wire-level payload test cannot drift
 * apart: a secret added here is immediately asserted against both the scrubbing
 * functions and the bytes the adapter actually sends.
 */
export const SECRETS = {
  note: "client is unhappy about pricing, threatening to churn",
  email: "britt@tinycrm.biz",
  jwt: "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz0123456789.signature",
  dbPassword: "sup3rs3cret",
  webhookSecret: "xxxxxxxxxxxxxxxxxxxxxxxx",
  resend: "re_TestKey_0123456789abcdefghij",
};

/** Shaped like a real Node stack: the message first, then the frames. */
export const realisticStack = [
  `Error: Invalid \`prisma.contact.findMany()\` invocation: note body was "${SECRETS.note}"`,
  `for ${SECRETS.email} with session ${SECRETS.jwt}`,
  `db postgresql://tinycrm_app:${SECRETS.dbPassword}@db.internal:5432/tinycrm`,
  `webhook https://hooks.slack.com/services/T00000000/B00000000/${SECRETS.webhookSecret}`,
  `resend ${SECRETS.resend}`,
  "    at handler (/var/task/src/lib/actions/contacts.ts:42:11)",
].join("\n");

/**
 * The same secrets in an error that is *not* a Prisma failure.
 *
 * `realisticStack` above hides a weakness: the rule that strips Prisma's quoted
 * row spans to the first stack frame, so it removed the entire block in one go
 * and every other rule was never exercised. Two secrets — a session JWT and a
 * vendor API key — survived a plain TypeError while the Prisma fixture passed.
 *
 * Any assertion worth making about leaks should be made against both.
 */
export const plainStack = [
  "TypeError: upstream rejected the call",
  `  ctx for ${SECRETS.email} session ${SECRETS.jwt}`,
  `  db postgresql://tinycrm_app:${SECRETS.dbPassword}@db.internal:5432/tinycrm`,
  `  hook https://hooks.slack.com/services/T00000000/B00000000/${SECRETS.webhookSecret}`,
  `  key ${SECRETS.resend}`,
  "    at handler (/var/task/src/lib/actions/contacts.ts:42:11)",
].join("\n");
