import { DraftBanner, LegalPage, NeedsDetail, Section } from "@/components/marketing/legal";

export const metadata = {
  title: "Privacy",
  description: "What Tiny CRM collects, where it goes, and what it never does.",
};

/**
 * The privacy notice.
 *
 * Written from the code, not from a template. Every behavioural claim here is
 * traceable to an implementation — the per-workspace AI modes to
 * `Workspace.aiMode` and `src/lib/ai/privacy.ts`, the logging allowlist to
 * `redact()` in `src/lib/logger.ts`, the prompt bound to
 * `MAX_PROMPT_CHARS`, the hashing cost to `src/lib/auth`, row-level security to
 * `prisma/postgres/002_row_level_security.sql`.
 *
 * Business and legal facts are marked with `NeedsDetail` instead of being
 * invented. `docs/PRIVACY-NOTICE-DRAFT.md` holds the longer internal version and
 * the `[LEGAL REVIEW]` notes behind these gaps.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy notice"
      updated="2 October 2026"
      intro={<DraftBanner />}
    >
      <Section id="what-this-is" heading="1. What Tiny CRM is, and why that shapes this notice">
        <p>
          Tiny CRM stores information about <strong>your</strong> contacts, companies, deals,
          projects and notes. Most of what it holds was typed by you and is about somebody else — a
          person who is not a user here and has no direct relationship with us. That asymmetry shapes
          everything below: you decide what goes in, and we handle it on your behalf.
        </p>
        <p>
          Tiny CRM is operated by <strong>Artifact Digital LLC</strong>, 178 N. Cuyamaca St.,
          El Cajon, CA 92020, United States.
        </p>
        <p>
          In data-protection terms this most likely makes us a <em>processor</em> for the contact
          data you enter and a <em>controller</em> for your own account data. Confirming that split
          is <NeedsDetail>for legal review</NeedsDetail>, and it determines what else this notice
          must say.
        </p>
      </Section>

      <Section id="collected" heading="2. What is collected">
        <p><strong>What you give us</strong></p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your account: name, email address, password (hashed), time zone, optional job title and avatar.</li>
          <li>Your CRM content: contacts, companies, deals, opportunities, projects, tasks, notes, tags, custom fields, and files you upload.</li>
          <li>Workspace structure: workspace names, members you invite, their roles and record-level access.</li>
        </ul>
        <p><strong>What the service generates</strong></p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Sign-in sessions, with a truncated IP address and a device description, so you can review and revoke them.</li>
          <li>An audit log of security-relevant actions, which is append-only and cannot be edited or deleted by the application.</li>
          <li>Counts of AI model requests per month, used to enforce your plan&apos;s allowance.</li>
          <li>Relationship, momentum and health scores, computed locally from the data you entered.</li>
        </ul>
        <p><strong>What is never collected</strong></p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Payment card details. Card data is entered on Stripe&apos;s own pages and never reaches our servers. We store only a Stripe customer identifier, your plan, its status and its renewal or end date.</li>
          <li>Advertising or cross-site tracking identifiers. There is no advertising network, no analytics pixel and no third-party tracker.</li>
          <li>Your password in any readable form.</li>
        </ul>
      </Section>

      <Section id="cookies" heading="3. Cookies">
        <p>
          Cookies are used for sign-in and security only: a session cookie, and a
          cross-site-request-forgery token. There are no advertising or analytics cookies, so there
          is nothing to opt out of. Whether a consent banner is nonetheless required where you live
          is <NeedsDetail>for legal review</NeedsDetail>.
        </p>
      </Section>

      <Section id="use" heading="4. How information is used">
        <ul className="list-disc space-y-1 pl-5">
          <li>To run the product: storing and showing you your own data.</li>
          <li>To authenticate you and keep accounts secure, including lockout after repeated failed sign-ins and optional two-factor authentication.</li>
          <li>To enforce plan limits, which requires counting what you have created and how many AI model requests you have used this month.</li>
          <li>To take payment, through Stripe, if you subscribe.</li>
          <li>To send transactional email: verification, password reset, invitations. Not marketing.</li>
        </ul>
        <p>
          Your CRM content is <strong>not</strong> used to train any machine-learning model, ours or
          anyone else&apos;s, and is not sold or shared for advertising.
        </p>
      </Section>

      <Section id="where" heading="5. Where data goes">
        <p>Three categories of data leave this deployment, and no others:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li><strong>To an AI provider</strong>, and only when the workspace permits it — see section 6.</li>
          <li>
            <strong>To Stripe</strong>, if you subscribe: your email address and name, so an invoice
            can be addressed, plus the plan you chose. No CRM content is sent.
          </li>
          <li>
            <strong>Operational telemetry</strong> — error reports and logs, restricted to an
            allowlist: error type, message, stack trace, request identifier, route, and
            user or workspace <em>identifiers</em>. Messages are stripped of quoted database values
            and email addresses. CRM record contents, note text, email bodies, AI prompts, passwords
            and tokens are never included.
          </li>
        </ol>
        <p>The services this deployment relies on:</p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-left text-body">
                <th className="py-2 pr-4 font-semibold">Service</th>
                <th className="py-2 pr-4 font-semibold">Purpose</th>
                <th className="py-2 font-semibold">Processing location</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Vercel</td>
                <td className="py-2 pr-4">Application hosting</td>
                {/* Verified: vercel.json pins `regions: ["pdx1"]`. */}
                <td className="py-2">US West (Oregon)</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Neon</td>
                <td className="py-2 pr-4">PostgreSQL database</td>
                {/*
                  Read from the endpoint the plan/usage audit connected to:
                  ep-aged-smoke-arfenoc5.c-4.us-west-2.aws.neon.tech — so the
                  region is evidence, not assumption, and matches Vercel's pdx1.

                  Two limits on that evidence, which is why the page is still a
                  draft. The host establishes the region of *that endpoint*, not
                  that it belongs to the production branch — every Neon branch has
                  its own endpoint, so this needs confirming in the Neon console.
                  And the host carries no `-pooler` segment, meaning the audit used
                  the direct endpoint while the application most likely uses the
                  pooled one; both reach the same branch, but the two strings will
                  not be identical when compared.
                */}
                <td className="py-2">US West (Oregon)</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Cloudflare R2</td>
                <td className="py-2 pr-4">Storage for uploaded files (bucket <code>tiny-crm-documents</code>)</td>
                {/*
                  Cloudflare's own label for this bucket, quoted as given. R2
                  location hints name a broad area, not a country or a state, and
                  Cloudflare does not commit to a specific one within it — so
                  "Western North America" is the whole of what is known. Writing
                  "United States" or "California" here would be an inference
                  dressed as a fact about where customer files sit.
                */}
                <td className="py-2">Western North America (WNAM)</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Anthropic</td>
                <td className="py-2 pr-4">AI model provider, where AI is enabled</td>
                {/* Verified: no `inference_geo` anywhere in src/, so routing is
                    Anthropic's global default rather than pinned to a region. */}
                <td className="py-2">Not pinned to a region</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Stripe</td>
                <td className="py-2 pr-4">Payment processing, if you subscribe</td>
                <td className="py-2"><NeedsDetail>per Stripe&apos;s terms</NeedsDetail></td>
              </tr>
              <tr>
                {/*
                  Delivery is configured — the production gate warns on every boot
                  when either mail variable is missing, and that warning is absent
                  from all 612 boot records in the last 48 hours, so both are set.
                  Which provider receives the mail is a different question: the
                  adapter is a generic authenticated JSON POST, and the endpoint URL
                  is encrypted and not readable from here.
                */}
                <td className="py-2 pr-4 text-body"><NeedsDetail>email provider name</NeedsDetail></td>
                <td className="py-2 pr-4">Transactional email only — verification, password reset, invitations</td>
                <td className="py-2"><NeedsDetail>provider region</NeedsDetail></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Whether international transfer terms are required for your jurisdiction is{" "}
          <NeedsDetail>for legal review</NeedsDetail>. Whether a data processing agreement is
          offered, and on what terms, is <NeedsDetail>a business decision</NeedsDetail>.
        </p>
      </Section>

      <Section id="ai" heading="6. Artificial intelligence">
        <p>
          <strong>AI is controlled per workspace, not per account.</strong> One person may run their
          own business and a client&apos;s in the same account under different obligations, so the
          setting lives on the workspace.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Disabled — nothing leaves.</strong> Relationship scoring, deal momentum, stall
            detection, project health, duplicate detection, the hygiene scan and the daily brief all
            keep working. They are computed by the application and never needed a model.
          </li>
          <li>
            <strong>Enabled</strong> — a bounded slice of workspace content may be sent to the
            provider to write prose and answer questions. The amount is capped in code at 16,000
            characters per request, including the question and any prior turns; longer context is
            truncated before it is sent, not after.
          </li>
          <li>
            <strong>Private</strong> — reserved for a provider under a zero-retention agreement. It
            behaves exactly like <em>Disabled</em> until an operator asserts that such an agreement
            exists. It fails closed.
          </li>
        </ul>
        <p>
          When one request spans several workspaces and any of them has AI disabled, the entire
          answer is produced locally. The safe direction is chosen deliberately: the alternative
          would be transmitting one workspace&apos;s records because a different workspace allowed
          it.
        </p>
        <p>
          <strong>Never sent to a model provider, in any mode:</strong> passwords, session tokens,
          API keys or any other credential. A contact&apos;s email address or phone number is
          included only when that specific record is the one being summarised.
        </p>
        <p>
          Only requests that actually reach a paid model count against your monthly allowance. The
          built-in engine is unmetered on every plan, including Free.
        </p>
        <p>
          <strong>We make no claim that the AI provider retains nothing.</strong> Whether prompts are
          retained, and for how long, is governed by our contract with that provider. If that matters
          to you, set the workspace to <em>Disabled</em> — the deterministic features are unaffected.
          The exact retention position is <NeedsDetail>for legal review</NeedsDetail>.
        </p>
      </Section>

      <Section id="security" heading="7. Security">
        <ul className="list-disc space-y-1 pl-5">
          <li>Passwords are hashed with bcrypt and never stored in a readable form.</li>
          <li>
            Workspace isolation is enforced by the database itself through row-level security, not
            only by application code. A query that arrives without a workspace context returns
            nothing rather than everything.
          </li>
          <li>Optional two-factor authentication, with recovery codes.</li>
          <li>Sessions can be revoked individually or all at once, and a password change invalidates existing sessions.</li>
          <li>The audit log is append-only: the application&apos;s database role is not permitted to update or delete its rows.</li>
          <li>All traffic is served over HTTPS.</li>
        </ul>
        <p>
          No security claim should be read as a guarantee. Our breach-notification commitments and
          timelines are <NeedsDetail>for legal review</NeedsDetail>.
        </p>
      </Section>

      <Section id="retention" heading="8. Retention">
        <ul className="list-disc space-y-1 pl-5">
          <li>Deleted records go to Trash and remain recoverable by you; they are not purged automatically.</li>
          <li>Deleting a workspace is scheduled rather than immediate: the workspace becomes read-only for a grace period, so an accidental or hostile deletion can be reversed before anything is destroyed.</li>
          <li>Expired sessions, used authentication tokens and rate-limit counters are purged automatically.</li>
          <li>Audit and security records are kept deliberately, because their value is in covering a period you may need to ask about later.</li>
        </ul>
        <p>
          A published maximum retention period after account closure, and the retention term for
          audit records, are <NeedsDetail>a business decision</NeedsDetail>.
        </p>
      </Section>

      <Section id="choices" heading="9. Your choices">
        <ul className="list-disc space-y-1 pl-5">
          <li>Export everything you have entered to CSV, at any time, without asking us.</li>
          <li>Turn AI off per workspace, and keep every deterministic feature.</li>
          <li>Review and revoke sessions; enable two-factor authentication.</li>
          <li>Delete records, or a whole workspace.</li>
        </ul>
        <p>
          Requests about data belonging to <em>your</em> contacts generally reach you rather than us,
          because you decide what is stored. How we handle a request that comes to us directly, and
          the statutory rights that apply, are <NeedsDetail>for legal review</NeedsDetail>.
        </p>
        <p>
          Privacy requests go to{" "}
          <a href="mailto:privacy@tinycrm.biz" className="text-brand-600 hover:underline dark:text-brand-400">
            privacy@tinycrm.biz
          </a>.
        </p>
      </Section>

      <Section id="not-claimed" heading="10. What is deliberately not claimed">
        <p>
          Stating the limits plainly is more useful than implying more than is true:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>No certification is claimed — not SOC 2, not ISO 27001, not HIPAA.</li>
          <li>No zero-retention guarantee from any AI provider.</li>
          <li>No uptime or availability commitment.</li>
          <li>Backups exist and have been restore-tested, but no recovery-time guarantee is offered.</li>
        </ul>
      </Section>

      <Section id="children" heading="11. Children">
        <p>Tiny CRM is a business tool and is not directed at children.</p>
      </Section>

      <Section id="changes" heading="12. Changes and contact">
        <p>
          If this notice changes materially we will say so in the product rather than relying on you
          to re-read it. The notification method and notice period are{" "}
          <NeedsDetail>a business decision</NeedsDetail>.
        </p>
        <p>
          Artifact Digital LLC, 178 N. Cuyamaca St., El Cajon, CA 92020, United States. Contact:{" "}
          <a href="mailto:privacy@tinycrm.biz" className="text-brand-600 hover:underline dark:text-brand-400">
            privacy@tinycrm.biz
          </a>. Governing law and jurisdiction: <NeedsDetail>for legal review</NeedsDetail> — a
          business address is not a choice of law.
        </p>
      </Section>
    </LegalPage>
  );
}
