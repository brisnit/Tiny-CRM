/**
 * The notice sender. Dry run by default; cannot reach a customer by accident.
 *
 *   npx tsx scripts/send-notice.ts --notice=privacy-2026-11            # dry run
 *   npx tsx scripts/send-notice.ts --notice=privacy-2026-11 --apply    # local sink only
 *   npx tsx scripts/send-notice.ts --notice=privacy-2026-11 --apply --live --max=N
 *   npx tsx scripts/send-notice.ts --notice=privacy-2026-11 --reconcile
 *
 * ## Three gates before a customer sees anything
 *
 * `--apply` alone is not enough. With the development sink or the log adapter
 * it exercises the whole path and sends nothing anywhere — that is how this
 * is tested. Reaching the real provider additionally needs `--live`, a
 * `--max` that matches the approved count, and the count typed back at a
 * prompt. Any one of them missing and it refuses.
 *
 * The reason for the belt and braces: every other destructive script here
 * acts on one row or one database, and is reversible. An email cannot be
 * recalled, and this one addresses every account at once.
 *
 * ## The ledger
 *
 * One `IdempotencyKey` row per recipient, scope `notice:<id>`, key the
 * lowercased address. The unique constraint on (scope, key) IS the
 * idempotency: a second run skips anyone already accepted, so a run that dies
 * halfway resumes rather than restarting, and a retry cannot double-send.
 *
 * `expiresAt` is set years out deliberately. The sweep in src/lib/jobs.ts
 * deletes expired idempotency keys, and this ledger is the evidence of when
 * notice was given — it must outlive the thing it proves.
 *
 * ## What this can and cannot tell you afterwards
 *
 * It records what the provider **accepted**. It cannot record what was
 * **delivered** or what **bounced**, because nothing in this application
 * receives delivery events from the mail provider — there is no webhook for
 * them, only the Stripe one. `--reconcile` reports those two categories as
 * unobservable rather than inferring them, and says what would have to exist
 * first. Treating "accepted" as "delivered" is exactly the mistake that makes
 * a notice obligation look discharged when it is not.
 */
import { createInterface } from "node:readline";

import { db } from "../src/lib/db";
import { env } from "../src/lib/env";
import { mailAdapterKind, sendMail } from "../src/lib/mail";
import { noticeWindow, NOTICE_DAYS } from "../src/lib/legal/notice-window";

/** Years, not days: this ledger is the evidence that notice was given. */
const LEDGER_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** Gentle by default. The provider throttles, and a throttle looks like a failure. */
const DEFAULT_PER_SECOND = 2;

type Status = "accepted" | "send_failed" | "delivered" | "bounced";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}
const has = (name: string) => process.argv.includes(`--${name}`);

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    let answered = false;
    const finish = (v: string) => { if (!answered) { answered = true; rl.close(); done(v); } };
    rl.question(question, (a) => finish(a.trim()));
    rl.on("close", () => finish(""));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `jane@example.com` -> `j•••@example.com`. Nothing identifying is printed. */
function mask(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "[malformed]";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(local.length - 1, 5)))}@${domain}`;
}

/**
 * Every account, not every workspace owner.
 *
 * The notice governs what Tiny CRM does with a person's data, so a member
 * whose colleague owns the workspace is a data subject too. Suspended
 * accounts are included: disabling an account does not end the obligation to
 * tell that person what we do with their data.
 */
async function recipients(): Promise<string[]> {
  const rows = await db.user.findMany({ select: { email: true }, orderBy: { createdAt: "asc" } });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

async function ledger(noticeId: string) {
  const rows = await db.idempotencyKey.findMany({
    where: { scope: `notice:${noticeId}` },
    select: { key: true, status: true, result: true, createdAt: true },
  });
  return rows;
}

/** The message. Body text lives in docs/legal/, and is passed in deliberately. */
function noticeMessage(subject: string, body: string) {
  return { subject, text: body };
}

async function main() {
  const noticeId = arg("notice");
  if (!noticeId) {
    console.error("\n--notice=<id> is required. It names the ledger and makes re-runs idempotent.\n");
    process.exit(1);
  }
  const scope = `notice:${noticeId}`;
  const apply = has("apply");
  const live = has("live");
  const reconcile = has("reconcile");
  const perSecond = Number(arg("rate") ?? DEFAULT_PER_SECOND);
  const max = arg("max") ? Number(arg("max")) : null;

  const adapter = mailAdapterKind();
  const list = await recipients();
  const existing = await ledger(noticeId);
  const byKey = new Map(existing.map((r) => [r.key, r]));

  console.log(`\nNotice sender — ${reconcile ? "RECONCILE" : apply ? (live ? "LIVE SEND" : "APPLY (sink)") : "DRY RUN"}`);
  console.log("=".repeat(72));
  console.log(`  notice id     ${noticeId}`);
  console.log(`  database      ${env.databaseUrl.replace(/:\/\/[^@]*@/, "://[redacted]@")}`);
  console.log(`  mail adapter  ${adapter}${adapter === "http" ? "  <- REAL PROVIDER" : "  (nothing leaves this machine)"}`);

  // ---- Reconciliation --------------------------------------------------
  if (reconcile) {
    const counts: Record<string, number> = {};
    for (const row of existing) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const accepted = counts.accepted ?? 0;
    const failed = counts.send_failed ?? 0;
    const delivered = counts.delivered ?? 0;
    const bounced = counts.bounced ?? 0;
    const attempted = existing.length;
    const notAttempted = list.filter((e) => !byKey.has(e)).length;

    console.log("\n  RECONCILIATION — five populations, counted separately");
    console.log(`    recipients (the list)        ${list.length}`);
    console.log(`    never attempted              ${notAttempted}   ${notAttempted ? "<- these people have NOT been given notice" : ""}`);
    console.log(`    attempted                    ${attempted}`);
    console.log(`      accepted by the provider   ${accepted}`);
    console.log(`      failed at send             ${failed}   ${failed ? "<- not given notice" : ""}`);
    console.log(`      confirmed delivered        ${delivered}`);
    console.log(`      bounced                    ${bounced}`);
    const unresolved = accepted - delivered - bounced;
    console.log(`      unresolved                 ${unresolved}   (accepted, no delivery outcome known)`);

    console.log("\n  WHY 'unresolved' IS THE WHOLE OF 'accepted' TODAY");
    console.log("    Nothing in this application receives delivery events from the mail");
    console.log("    provider. There is no webhook for delivered, bounced or complained —");
    console.log("    the only provider webhook here is Stripe's. So 'accepted' means the");
    console.log("    provider took the message, and nothing more.");
    console.log("    To populate delivered and bounced, a provider webhook has to exist and");
    console.log("    write back into this ledger. Until then, reporting 'accepted' as");
    console.log("    'delivered' would make a notice obligation look discharged when it is");
    console.log("    not, so this refuses to do it.");

    const arithmetic = notAttempted + accepted + failed === list.length;
    console.log(`\n    arithmetic checks out: ${arithmetic ? "yes" : "NO — investigate"}`);

    // ---- When activation becomes permissible -------------------------
    //
    // Measured from the LAST acceptance, not the first. The commitment is to
    // each person, so it is met only when whoever was notified last has had
    // their 30 days. See src/lib/legal/notice-window.ts.
    const acceptedAt = existing
      .filter((r) => r.status === "accepted" || r.status === "delivered")
      .map((r) => {
        try {
          const parsed = JSON.parse(r.result ?? "{}") as { at?: string };
          return parsed.at ? new Date(parsed.at) : r.createdAt;
        } catch {
          return r.createdAt;
        }
      });
    const window = noticeWindow(acceptedAt);

    console.log(`\n  NOTICE WINDOW (${NOTICE_DAYS} days, measured per person)`);
    if (window.count === 0) {
      console.log("    Nobody has been given notice. Activation is not permissible,");
      console.log("    and no amount of waiting changes that.");
    } else {
      console.log(`    acceptances counted      ${window.count}`);
      console.log(`    earliest acceptance      ${window.earliest?.toISOString()}   (context only)`);
      console.log(`    latest acceptance        ${window.latest?.toISOString()}   <- the window runs from here`);
      console.log(`    activation permissible   ${window.activationFrom?.toISOString()}`);
      console.log(
        `    elapsed for everyone     ${window.elapsed ? "yes" : `no — ${window.daysRemaining} day(s) to wait`}`,
      );
    }

    const blockers = [
      notAttempted > 0 ? `${notAttempted} never attempted` : null,
      failed > 0 ? `${failed} failed at send` : null,
      !window.elapsed ? "the notice window has not elapsed for everyone" : null,
    ].filter(Boolean);
    console.log("\n  ACTIVATION GATE");
    if (blockers.length === 0) {
      console.log("    All three conditions met: every recipient attempted, none failed,");
      console.log("    and the last person notified has had the full period.");
    } else {
      console.log("    NOT PERMISSIBLE:");
      for (const b of blockers) console.log(`      - ${b}`);
    }
    await db.$disconnect();
    return;
  }

  // ---- Selection -------------------------------------------------------
  const pending = list.filter((email) => byKey.get(email)?.status !== "accepted");
  const alreadyDone = list.length - pending.length;

  console.log("\n  AUDIENCE");
  console.log(`    recipients               ${list.length}`);
  console.log(`    already accepted         ${alreadyDone}   (skipped — the ledger makes this idempotent)`);
  console.log(`    to attempt this run      ${pending.length}`);
  console.log(`    rate                     ${perSecond}/second`);
  if (pending.length) {
    console.log(`    first few                ${pending.slice(0, 3).map(mask).join(", ")}`);
  }

  // ---- Gates -----------------------------------------------------------
  if (!apply) {
    console.log("\n  DRY RUN. Nothing was sent and the ledger was not written.");
    console.log("  Re-run with --apply to exercise the full path against the local sink.\n");
    await db.$disconnect();
    return;
  }

  if (adapter === "http" && !live) {
    console.error(
      "\nREFUSED. The mail adapter is the real provider and --live was not given.\n" +
        "  --apply alone is for the development sink. Nothing was sent.\n",
    );
    process.exit(1);
  }

  if (live) {
    if (adapter !== "http") {
      console.error("\nREFUSED. --live was given but the adapter is not the real provider.\n");
      process.exit(1);
    }
    if (max === null) {
      console.error(
        "\nREFUSED. --live requires --max=<approved count>, so a change to the\n" +
          "  recipient query cannot silently widen the audience. Nothing was sent.\n",
      );
      process.exit(1);
    }
    if (list.length > max) {
      console.error(
        `\nREFUSED. The list is ${list.length}, larger than the approved --max=${max}.\n` +
          `  Someone must approve the larger number. Nothing was sent.\n`,
      );
      process.exit(1);
    }
    const typed = await ask(`\n  Type the number of recipients (${pending.length}) to send: `);
    if (typed !== String(pending.length)) {
      console.log("\n  Not confirmed. Nothing was sent.\n");
      await db.$disconnect();
      return;
    }
  }

  const subject = arg("subject") ?? "Changes to the Tiny CRM privacy notice";
  const bodyPath = arg("body");
  if (!bodyPath) {
    console.error("\n--body=<path to a text file> is required when applying.\n");
    process.exit(1);
  }
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(bodyPath, "utf8");
  const message = noticeMessage(subject, body);

  // ---- The run ---------------------------------------------------------
  let accepted = 0;
  let failed = 0;
  const interval = perSecond > 0 ? 1000 / perSecond : 0;

  for (const email of pending) {
    // Claim first. A unique violation means another run already has it.
    try {
      await db.idempotencyKey.create({
        data: {
          scope,
          key: email,
          status: "in_progress",
          expiresAt: new Date(Date.now() + LEDGER_TTL_MS),
        },
      });
    } catch {
      console.log(`    skip      ${mask(email)}  (already claimed)`);
      continue;
    }

    const result = await sendMail({ to: email, ...message });
    const status: Status = result.delivered ? "accepted" : "send_failed";
    await db.idempotencyKey.update({
      where: { scope_key: { scope, key: email } },
      data: {
        status,
        result: JSON.stringify({
          at: new Date().toISOString(),
          adapter: result.adapter,
          providerMessageId: result.providerMessageId ?? null,
          error: result.error ?? null,
        }),
      },
    });
    if (status === "accepted") accepted += 1;
    else failed += 1;
    console.log(`    ${status === "accepted" ? "accepted " : "FAILED   "} ${mask(email)}`);
    if (interval) await sleep(interval);
  }

  console.log("\n  RESULT");
  console.log(`    accepted    ${accepted}`);
  console.log(`    failed      ${failed}   ${failed ? "<- these people have NOT been given notice" : ""}`);
  console.log(`    adapter     ${adapter}${adapter === "http" ? "" : "  (nothing actually left this machine)"}`);
  console.log(`\n  Reconcile with: --notice=${noticeId} --reconcile\n`);

  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(`\n${String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/g, "[redacted]")}\n`);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
