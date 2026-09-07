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
