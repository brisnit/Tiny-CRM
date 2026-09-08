# Should this repository be public?

It currently is: `github.com/brisnit/Tiny-CRM`, public. This is the audit, not
a change — visibility has not been altered.

## What is genuinely safe about it today

- **No secrets in history.** Verified with gitleaks over all 55 commits, full
  history, not just a push range. The two findings were false positives (a
  fabricated test fixture and a list of SQL filenames) and are allowlisted as
  exact literals.
- **No credentials in the working tree.** Every secret lives in
  `~/.config/tinycrm/` at mode 600, outside the repository. `.env` is ignored.
- **Nothing in the client bundle.** Verified against the deployed assets.
- **Security does not depend on obscurity.** RLS is enforced by the database
  against an unprivileged role; authorization is server-side on every path.
  Publishing the policy SQL does not weaken it. This is the property that makes
  a public repository defensible at all.

## What being public actually costs

1. **It advertises the attack surface precisely.** An attacker reads
   `src/proxy.ts`, `002_row_level_security.sql` and `scripts/restore-probe.mjs`
   and knows the shape of every control, the name of the runtime role, and that
   `/api/diagnostics/error` exists. None of that is a vulnerability. All of it
   removes reconnaissance work.
2. **It publishes the gaps, in writing.** `docs/PRODUCTION-READINESS.md` is an
   unusually candid document — it names MFA as enrolment-only, the 6-hour
   recovery window, the missing DPA, and every YELLOW. That honesty is exactly
   what makes it useful internally and exactly what makes it a briefing note
   externally.
3. **Fixes are visible before customers get them.** A commit that repairs a
   real defect describes the defect, publicly, at the moment it is pushed —
   while every beta customer is still on the previous deployment.
4. **Customer-facing perception.** A business owner storing their contacts in
   Tiny CRM may not distinguish "the source is open" from "my data is open."

## Recommendation

**Make it private for the duration of the private beta.** Not because anything
in it is unsafe today, but because point 3 is a live cost the moment real
customers exist: this project's own practice is to write commit messages that
explain the defect being fixed, and that practice becomes a disclosure feed
once someone is relying on the deployment.

Open it again deliberately, if you want to, when the product is public and the
security documentation is written for an external reader rather than for you.

**Your call — no action taken.** If you prefer to keep it public, the one thing
I would change is to stop describing unfixed weaknesses in commit messages, and
keep that detail in the scorecard instead.
