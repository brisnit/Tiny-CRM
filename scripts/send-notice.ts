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

/**
 * Records delivery outcomes read off the Resend dashboard.
 *
 * There is no delivery webhook in this application, so for this campaign the
 * outcomes are reconciled by hand. Eight recipients is small enough that a
 * person can read the dashboard and write down what happened; it is not a
 * substitute for a webhook, and the package says so.
 *
 * Input is CSV, one recipient per line, header optional:
 *
 *     email,status,providerMessageId
 *     someone@example.com,delivered,re_abc123
 *     other@example.com,bounced,re_def456
 *
 * `status` must be `delivered` or `bounced`. Anything else is refused rather
 * than guessed at — "sent", "ok" and "complained" all mean different things
 * and none of them is a delivery.
 */
async function record(noticeId: string, path: string, apply: boolean) {
  const scope = `notice:${noticeId}`;
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

  const parsed: { email: string; status: Status; providerMessageId: string | null }[] = [];
  const problems: string[] = [];
  for (const [index, line] of lines.entries()) {
    const cells = line.split(",").map((c) => c.trim());
    if (index === 0 && cells[0]?.toLowerCase() === "email") continue; // header
    const [email, status, providerMessageId] = cells;
    if (!email || !status) {
      problems.push(`line ${index + 1}: needs at least email,status`);
      continue;
    }
    if (status !== "delivered" && status !== "bounced") {
      problems.push(`line ${index + 1}: status "${status}" is not delivered or bounced`);
      continue;
    }
    parsed.push({ email: email.toLowerCase(), status, providerMessageId: providerMessageId || null });
  }

  const known = new Map(
    (await ledger(noticeId)).map((r) => [r.key, r]),
  );
  for (const row of parsed) {
    if (!known.has(row.email)) {
      problems.push(`${row.email}: no ledger entry — was this address ever sent to?`);
    }
  }

  console.log(`\n  RECORDING OUTCOMES from ${path}`);
  console.log(`    rows parsed     ${parsed.length}`);
  console.log(`    delivered       ${parsed.filter((r) => r.status === "delivered").length}`);
  console.log(`    bounced         ${parsed.filter((r) => r.status === "bounced").length}`);
  if (problems.length) {
    console.log(`\n    PROBLEMS (${problems.length}) — nothing is written until these are fixed:`);
    for (const p2 of problems) console.log(`      ${p2}`);
    process.exit(1);
  }

  if (!apply) {
    console.log("\n    Dry run. Re-run with --apply to write these to the ledger.\n");
    return;
  }

  for (const row of parsed) {
    const before = known.get(row.email)!;
    let prior: Record<string, unknown> = {};
    try { prior = JSON.parse(before.result ?? "{}") as Record<string, unknown>; } catch { prior = {}; }
    await db.idempotencyKey.update({
      where: { scope_key: { scope, key: row.email } },
      data: {
        status: row.status,
        result: JSON.stringify({
          ...prior,
          // Keep the acceptance time: the notice window is measured from it,
          // and overwriting it here would silently move everyone's deadline.
          providerMessageId: row.providerMessageId ?? prior.providerMessageId ?? null,
          outcome: row.status,
          outcomeRecordedAt: new Date().toISOString(),
          outcomeSource: "resend dashboard, recorded by hand",
        }),
      },
    });
    console.log(`    ${row.status.padEnd(10)} ${mask(row.email)}  ${row.providerMessageId ?? "(no id)"}`);
  }
  console.log(`\n    Written. Reconcile with --notice=${noticeId} --reconcile\n`);
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

  const recordPath = arg("record");
  if (recordPath) {
    await record(noticeId, recordPath, apply);
    await db.$disconnect();
    return;
  }

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
    // `delivered` and `bounced` REPLACE `accepted` on the row, so the four
    // statuses are disjoint and unresolved is simply whatever is still sitting
    // at `accepted`. An earlier version subtracted, which would have counted
    // the same recipient twice and under-reported unresolved to zero.
    const unresolved = accepted;
    console.log(`      unresolved                 ${unresolved}   (accepted, no delivery outcome recorded yet)`);

    console.log("\n  WHERE 'delivered' AND 'bounced' COME FROM");
    console.log("    Nothing in this application receives delivery events from the mail");
    console.log("    provider. There is no webhook for delivered, bounced or complained —");
    console.log("    the only provider webhook here is Stripe's. So a send records only");
    console.log("    'accepted': the provider took the message, and nothing more.");
    console.log("    For this campaign the outcomes are reconciled BY HAND: read each");
    console.log("    recipient's status and message id off the Resend dashboard, write");
    console.log("    them into a CSV, and run --record. Eight recipients makes that");
    console.log("    tractable; it is not a substitute for a webhook at any larger size.");
    console.log("    Until a recipient is recorded, they stay unresolved — and unresolved");
    console.log("    blocks activation, because 'the provider took it' is not 'they got it'.");

    const arithmetic =
      notAttempted + accepted + failed + delivered + bounced === list.length;
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
      if (window.invalid > 0) {
        console.log(`    unreadable timestamps    ${window.invalid}   <- blocks the check`);
      }
      // No date and no countdown when the window is blocked: there isn't one,
      // and printing "undefined" or "Infinity day(s)" invites someone to read
      // past it.
      console.log(
        `    activation permissible   ${
          window.activationFrom ? window.activationFrom.toISOString() : "cannot be determined"
        }`,
      );
      console.log(
        `    elapsed for everyone     ${
          window.blocked
            ? "cannot be determined"
            : window.elapsed
              ? "yes"
              : `no — ${window.daysRemaining} day(s) to wait`
        }`,
      );
    }
    if (window.blocked && window.count > 0) {
      console.log(`    BLOCKED: ${window.blocked}`);
    }

    const blockers = [
      notAttempted > 0 ? `${notAttempted} never attempted` : null,
      failed > 0 ? `${failed} failed at send` : null,
      // Unresolved and bounced each need a person to look, not a rule to
      // decide. A bounce means that recipient was never notified at all; an
      // unresolved one means we cannot say either way.
      unresolved > 0
        ? `${unresolved} unresolved — accepted by the provider, delivery outcome unknown; reconcile with --record`
        : null,
      bounced > 0
        ? `${bounced} bounced — those recipients have NOT been given notice; needs review`
        : null,
      window.blocked ? window.blocked : null,
      !window.elapsed && !window.blocked
        ? "the notice window has not elapsed for everyone"
        : null,
    ].filter(Boolean);
    console.log("\n  ACTIVATION GATE");
    if (blockers.length === 0) {
      console.log("    Every recipient attempted, none failed, every one confirmed");
      console.log("    delivered, and the last person notified has had the full period.");
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
