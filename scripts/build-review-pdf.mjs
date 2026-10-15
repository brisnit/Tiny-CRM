#!/usr/bin/env node
/**
 * Builds the private review PDF from the legal drafts.
 *
 *   node scripts/build-review-pdf.mjs
 *
 * ## Why this is a script and not a sequence of commands
 *
 * The first review PDF was produced by copying text into a document by hand.
 * The customer email then changed — two separate notices became one combined
 * one — and the copy did not, so a reviewer was handed a draft that had
 * already been superseded. Nothing flagged it; both documents were internally
 * consistent and only disagreed with each other.
 *
 * So every section below is EXTRACTED from its source document at build time.
 * If the source changes, the next build changes with it. If a heading this
 * script looks for is renamed, the build fails loudly rather than quietly
 * emitting a PDF with a section missing.
 *
 * Nothing here publishes, sends or schedules anything. It writes one file.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local date, deliberately: an ISO/UTC stamp reads as tomorrow from the
// afternoon onwards in California, on a document that is entirely about dates.
const OUT = "Tiny-CRM-privacy-drafts-for-review.pdf";

/** The dates under review. Stated once, as proposals, and never as settled. */
const PUBLISH_ON = "20 October 2026";
const INTEGRATIONS_ON = "23 November 2026";

const read = (p) => readFileSync(p, "utf8");

/**
 * Pull one section out of a markdown document, by its exact heading line.
 *
 * Runs to the next heading at the same level or shallower, so a `##` section
 * keeps its `###` subsections and stops at the next `##` or `#`. Throws if
 * the heading is not found — a renamed heading is a build failure, not a
 * silently shorter PDF.
 */
function section(path, heading, { dropHeading = false } = {}) {
  const lines = read(path).split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) {
    throw new Error(`${path}: heading not found: ${JSON.stringify(heading)}`);
  }
  const level = heading.match(/^#+/)[0].length;
  const atOrAbove = new RegExp(`^#{1,${level}} `);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (atOrAbove.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(dropHeading ? start + 1 : start, end).join("\n").trim();
}

/** Strip one level of blockquote, for text quoted in its source document. */
const unquote = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n")
    .trim();

const PKG = "docs/legal/PUBLICATION-PACKAGE.md";
const WORDING = "docs/legal/FINAL-WORDING.md";
const SENTRY = "docs/legal/PRIVACY-SENTRY-CORRECTION-DRAFT.md";
const DPA = "docs/legal/DPA-SENTRY-CORRECTION-DRAFT.md";

// The email, taken from the one place it lives. Everything from the subject
// line to the end of the quoted block.
const emailBlock = (() => {
  const lines = read(PKG).split("\n");
  const start = lines.findIndex((l) => l.startsWith("> **Subject:**"));
  if (start === -1) throw new Error(`${PKG}: the email's subject line was not found`);
  let end = start;
  while (end < lines.length && (lines[end].startsWith(">") || lines[end].trim() === "")) {
    if (lines[end].trim() === "" && !lines[end + 1]?.startsWith(">")) break;
    end += 1;
  }
  return unquote(lines.slice(start, end).join("\n"));
})();

const pagePreview = section(PKG, "## 4. The privacy page: current and future, distinguished");
const timeline = section(PKG, "## 6. The timeline, stated so Sentry is not misread");

const cover = `---
title: "Tiny CRM — privacy notice changes"
subtitle: "Private review draft — nothing published, nothing sent"
date: "Generated ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}"
---

# What this is, and what it is not

This document is for review. **Nothing in it has been published, and no email
has been sent to anybody.**

## The dates are proposed, pending approval

| | Proposed date | Status |
| --- | --- | --- |
| Publication of the updated page, and the customer email | **${PUBLISH_ON}** | **Proposed — pending your approval** |
| Integration provisions take effect | **${INTEGRATIONS_ON}** | **Proposed — pending your approval** |
| Sentry correction published | **${PUBLISH_ON}**, as a labelled correction | **Proposed — pending your approval** |

Real dates are written into the text below rather than left as
\`{PLACEHOLDER}\`, so that the email and the page can be read as the finished
thing. That is a drafting choice and not an approval: **nothing is scheduled
against these dates**, no email is queued, and the publication, the production
migrations and the integration feature itself all remain paused.

The 34 days between the two dates is deliberate. The commitment is 30 days'
notice to each customer, and the extra days absorb a send that slips without
anyone having to recalculate whether the commitment still holds.

## Still unresolved

**The production sender has not been confirmed in Resend.** Public DNS shows
the domain is set up for Resend, but that is not the same as Resend reporting
the domain verified, and it does not reveal which address the application
sends as. This is a blocker for sending and is described in the publication
package.

## How this document was built

Assembled by \`scripts/build-review-pdf.mjs\`, which extracts each section
from the drafts under \`docs/legal/\` at build time. An earlier review PDF was
transcribed by hand and went stale when the email changed underneath it; this
one cannot, because there is no second copy to fall out of step.

\\newpage

# The customer email, in full

One message, both changes, kept apart. There is no "reply to this message" —
the sender address has not been confirmed to accept replies — and no offer to
confirm historical connections, because the admin panel cannot answer that.

---

${emailBlock}

---

\\newpage

${pagePreview}

\\newpage

${timeline}

\\newpage

# The privacy notice wording

${section(WORDING, "# Privacy notice — new and changed sections", { dropHeading: true })}

\\newpage

# DPA — Annex B

${section(WORDING, "# DPA — Annex B", { dropHeading: true })}

\\newpage

# The Sentry correction, in detail

${section(SENTRY, "## Proposed wording") +
  "\n\n" +
  section(SENTRY, "## What the correction must NOT claim") +
  "\n\n" +
  section(SENTRY, "## Does this trigger the 30-day clause? — a proposed interpretation, for review")}

\\newpage

# DPA correction — reasoning

${section(DPA, "### Proposed row")}
`;

const work = mkdtempSync(join(tmpdir(), "review-pdf-"));
try {
  const md = join(work, "review.md");
  const html = join(work, "review.html");
  writeFileSync(md, cover);

  execFileSync("pandoc", [
    md,
    "--from=markdown",
    "--to=html5",
    "--standalone",
    "--metadata=title:Tiny CRM — privacy notice changes",
    "--css=" + writeCss(work),
    "--output=" + html,
  ]);

  execFileSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--print-to-pdf=" + OUT,
    "file://" + html,
  ]);
  console.log(`wrote ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function writeCss(dir) {
  const path = join(dir, "review.css");
  writeFileSync(
    path,
    `@page { margin: 18mm 16mm; }
     body { font: 10.5pt/1.5 Georgia, serif; color: #1a1a1a; max-width: none; }
     h1 { font-size: 17pt; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 0; }
     h2 { font-size: 13pt; margin-top: 1.6em; }
     h3 { font-size: 11.5pt; }
     table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: 1em 0; }
     th, td { border: 1px solid #ccc; padding: 5px 7px; text-align: left; vertical-align: top; }
     th { background: #f2f2f2; }
     code { font: 9.5pt ui-monospace, Menlo, monospace; background: #f4f4f4; padding: 0 3px; }
     pre { background: #f6f6f6; padding: 9px 11px; border-left: 3px solid #bbb; overflow-wrap: break-word;
           white-space: pre-wrap; font-size: 9pt; }
     blockquote { border-left: 3px solid #bbb; margin-left: 0; padding-left: 12px; color: #333; }
     hr { border: none; border-top: 1px solid #ddd; margin: 1.4em 0; }
     h1, h2, h3 { break-after: avoid; } table, pre, blockquote { break-inside: avoid; }`,
  );
  return path;
}
