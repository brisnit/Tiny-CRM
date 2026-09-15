import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { chromium } from "playwright";

import { db } from "../../helpers/fixtures";

/**
 * Compiles the authenticated routes the browser suites drive, before any suite
 * runs.
 *
 * Run by scripts/browser-tests.mjs, not by the test runner, and that is the
 * point. The runner's --test-timeout bounds a whole test file, before() hooks
 * included, so a warm-up inside a suite can never have more than 120 seconds —
 * and the first signed-in navigation on a CI runner compiles the entire
 * authenticated shell. That compile timed out the Notes suite on 1e356cc (at 60
 * seconds, in its sign-in) and again on a9dfdb8 (at the 120-second file limit,
 * after its sign-in budget was raised past it).
 *
 * The public routes are warmed with a plain fetch; these sit behind the
 * signed-out redirect, so they need a real session. Best-effort, like the public
 * warm-up: a failure here is reported and the suites still run, paying the
 * compile themselves. Every step prints how long it took, so a slow CI run
 * says whether the time went to compiling or to something that never answered.
 * Nothing identifying is printed.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3123";
const STEP_BUDGET_MS = 300_000;
const PASSWORD = `warmup-${randomUUID()}`;

function elapsed(since: number): string {
  return `${((performance.now() - since) / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const email = `warmup-${randomUUID().slice(0, 8)}@warmup.test`;
  const user = await db.user.create({
    data: {
      email,
      name: "Warmup Owner",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true },
  });

  const browser = await chromium.launch();
  try {
    const { provisionWorkspace } = await import("../../../src/lib/workspaces/provision");
    const workspace = await provisionWorkspace(user.id, { name: "Warmup Studio" });
    const opportunity = await db.opportunity.create({
      data: { workspaceId: workspace.id, name: "Warmup Opportunity" },
      select: { id: true },
    });

    const page = await browser.newPage();
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["sign-in page", async () => {
        await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: STEP_BUDGET_MS });
        await page.waitForSelector("#password", { timeout: STEP_BUDGET_MS });
        await page.waitForTimeout(750); // hydration
      }],
      ["sign in, landing on the authenticated shell", async () => {
        await page.fill("#email", email);
        await page.fill("#password", PASSWORD);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: STEP_BUDGET_MS });
      }],
      ["opportunity page", () =>
        page.goto(`${BASE_URL}/opportunities/${opportunity.id}`, { waitUntil: "domcontentloaded", timeout: STEP_BUDGET_MS })],
      ["settings → team", () =>
        page.goto(`${BASE_URL}/settings/team`, { waitUntil: "domcontentloaded", timeout: STEP_BUDGET_MS })],
    ];

    for (const [label, run] of steps) {
      const started = performance.now();
      try {
        await run();
        console.log(`  warm-up: ${label} — ${elapsed(started)}`);
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        console.log(`  warm-up: ${label} — FAILED after ${elapsed(started)} (${name})`);
        break;
      }
    }
  } finally {
    await browser.close();
    await db.workspaceMember.deleteMany({ where: { userId: user.id } });
    // Cascades to the opportunity made here.
    await db.workspace.deleteMany({ where: { ownerId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.log(`  warm-up: could not run (${error instanceof Error ? error.name : "Error"})`);
});
