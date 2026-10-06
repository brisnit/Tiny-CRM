import { LegalPage, Section } from "@/components/marketing/legal";
import { legalEffectiveDate } from "@/lib/legal";

export const metadata = {
  title: "Privacy",
  description: "What Tiny CRM collects, where it goes, and what is deliberately not claimed.",
};

/**
 * Privacy notice.
 *
 * Revised 5 October 2026 against the owner-approved review copy. The approved
 * decisions written in here are the controller/processor split, the factual cookie
 * description, breach notification without undue delay, and privacy-request
 * handling.
 *
 * Two things are deliberately NOT claimed as settled, and the wording is written
 * to avoid implying otherwise: international-transfer safeguards, and whether a
 * data processing agreement is available. The open operational questions behind
 * them are recorded in docs/legal/REVIEW-NOTES.md, which is internal and is not
 * rendered on the page.
 *
 * Nothing here claims legal review, certification, or compliance with any
 * particular jurisdiction — none of which would be true. The page simply states
 * what the software does and what is not offered, and the factual limitations
 * stay in the customer-facing text rather than moving to a banner: no data
 * processing agreement, no promise of data residency, retention as implemented,
 * and no tax currently collected.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice" effectiveOn={legalEffectiveDate()}>
      <Section id="what-this-is" heading="1. What Tiny CRM is, and why that shapes this notice">
        <p>
          Tiny CRM stores information about your contacts, companies, deals, projects and notes.
          Most of what it holds was typed by you and is about somebody else — a person who is not a
          user here and has no direct relationship with us. That asymmetry shapes everything below:
          you decide what goes in, and we handle it on your behalf.
        </p>
        <p>
          Tiny CRM is operated by <strong>Artifact Digital LLC</strong>, 178 N. Cuyamaca St., El
          Cajon, CA 92020, United States.
        </p>
        <p>
          <strong>Our role in handling personal data.</strong> Customers decide what personal data
          to enter into Tiny CRM and why. For that customer content, Artifact Digital LLC acts as a{" "}
          <strong>processor</strong>, handling the data on customers&apos; behalf to provide the
          service and follow their instructions, subject to applicable law. For personal data we use
          to manage accounts, authentication, billing, security and our business operations,
          Artifact Digital LLC acts as a <strong>controller</strong>. Customers are responsible for
          having the necessary permissions or other lawful basis to enter personal data into Tiny
          CRM. We remain responsible for our own obligations under applicable data-protection law.
        </p>
      </Section>

      <Section id="collected" heading="2. What is collected">
        <p className="font-medium text-body">What you give us</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Your account:</strong> name, email address, password (hashed), time zone,
            optional job title and avatar.
          </li>
          <li>
            <strong>Your CRM content:</strong> contacts, companies, deals, opportunities, projects,
            tasks, notes, tags, custom fields, and files you upload.
          </li>
          <li>
            <strong>Workspace structure:</strong> workspace names, members you invite, their roles
            and record-level access.
          </li>
        </ul>

        <p className="font-medium text-body">What the service generates</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Sign-in sessions, with a truncated IP address and a device description, so you can
            review and revoke them.
          </li>
          <li>
            An audit log of security-relevant actions, which is append-only and cannot be edited or
            deleted by the application.
          </li>
          <li>Counts of AI model requests per month, used to enforce your plan&apos;s allowance.</li>
          <li>
            Relationship, momentum and health scores, computed locally from the data you entered.
          </li>
        </ul>

        <p className="font-medium text-body">What is never collected</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Payment card details.</strong> Card data is entered on Stripe&apos;s own pages
            and never reaches our servers. We store only a Stripe customer identifier, your plan,
            its status and its renewal or end date.
          </li>
          <li>
            <strong>Advertising or cross-site tracking identifiers.</strong> There is no advertising
            network, no analytics pixel and no third-party tracker.
          </li>
          <li>Your password in any readable form.</li>
        </ul>
      </Section>

      <Section id="cookies" heading="3. Cookies">
        <p>
          Tiny CRM uses a session cookie to keep you signed in and a security cookie to help protect
          against cross-site request forgery. We do not currently use advertising or analytics
          cookies. You can manage cookies through your browser settings. Blocking these functional
          cookies may prevent sign-in or other features from working.
        </p>
      </Section>

      <Section id="use" heading="4. How information is used">
        <ul className="list-disc space-y-1 pl-5">
          <li>To run the product: storing and showing you your own data.</li>
          <li>
            To authenticate you and keep accounts secure, including lockout after repeated failed
            sign-ins and optional two-factor authentication.
          </li>
          <li>
            To enforce plan limits, which requires counting what you have created and how many AI
            model requests you have used this month.
          </li>
          <li>To take payment, through Stripe, if you subscribe.</li>
          <li>
            To send transactional email: verification, password reset, invitations. Not marketing.
          </li>
        </ul>
        <p>
          We do not use your CRM content to train machine-learning models, or sell or share it for
          advertising. AI-provider handling is described in section 6 below.
        </p>
      </Section>

      <Section id="where" heading="5. Where data goes">
        <p>
          We use service providers for hosting, database storage, file storage, transactional email,
          payment processing and, where enabled, AI inference. The table below describes the
          locations reported in our current configuration and provider documentation.{" "}
          <strong>It is not a guarantee that all provider processing is confined to those
          locations.</strong>
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-left text-body">
                <th className="py-2 pr-4 font-semibold">Service</th>
                <th className="py-2 pr-4 font-semibold">Purpose</th>
                <th className="py-2 font-semibold">Reported location or routing</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Vercel</td>
                <td className="py-2 pr-4">Application hosting</td>
                <td className="py-2">US West (Oregon)</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Neon</td>
                <td className="py-2 pr-4">PostgreSQL database</td>
                <td className="py-2">US West (Oregon) — AWS us-west-2</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Cloudflare R2</td>
                <td className="py-2 pr-4">
                  Storage for uploaded files (bucket <code>tiny-crm-documents</code>)
                </td>
                <td className="py-2">Western North America (WNAM)</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Anthropic</td>
                <td className="py-2 pr-4">AI model provider, where AI is enabled</td>
                <td className="py-2">Not pinned to a region</td>
              </tr>
              <tr className="border-b border-hairline/60">
                <td className="py-2 pr-4 text-body">Stripe</td>
                <td className="py-2 pr-4">Payment processing, if you subscribe</td>
                <td className="py-2">
                  Provider operates internationally; no country-only residency guarantee
                </td>
              </tr>
              <tr>
                <td className="py-2 pr-4 text-body">Resend</td>
                <td className="py-2 pr-4">
                  Transactional email only — verification, password reset, invitations
                </td>
                <td className="py-2">United States (storage)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Resend delivers through <strong>Amazon SES</strong>, which is Resend&apos;s own
          subprocessor rather than a service we contract with directly. Transactional email carries
          your name, your email address and a link — never CRM record contents.
        </p>
        <p>
          Resend stores account data, email metadata and delivery logs in the United States whatever
          sending region is selected; the sending region affects only where a message is dispatched
          from. Resend publishes its own subprocessor list and gives at least 14 days&apos; notice
          before changing it.
        </p>
        <p>
          <strong>International processing.</strong> Artifact Digital LLC is based in the United
          States. Tiny CRM and its service providers may process personal data outside your country.
          Our provider table describes the locations we have confirmed; we do not promise that data
          remains in your country.
        </p>
        <p>
          <strong>We do not currently offer a data processing agreement.</strong> If your use
          requires processing terms or international-transfer safeguards, contact{" "}
          <a
            href="mailto:privacy@tinycrm.biz"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            privacy@tinycrm.biz
          </a>{" "}
          before uploading personal data, so we can determine whether we can support your
          requirements.
        </p>
      </Section>

      <Section id="ai" heading="6. Artificial intelligence">
        <p>
          AI is controlled <strong>per workspace</strong>, not per account. One person may run their
          own business and a client&apos;s in the same account under different obligations, so the
          setting lives on the workspace.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Disabled — nothing leaves.</strong> No workspace content is sent to a model
            provider. Built-in scoring, detection and brief features continue to run within the
            application.
          </li>
          <li>
            <strong>Enabled</strong> — a bounded slice of workspace content may be sent to the
            provider to write prose and answer questions. The amount is capped in code at{" "}
            <strong>16,000 characters per request</strong>, including the question and any prior
            turns; longer context is truncated before it is sent, not after.
          </li>
          <li>
            <strong>Private model only</strong> — reserved for a provider covered by a
            zero-retention agreement. We currently hold no such agreement, so this mode behaves like
            Disabled.
          </li>
        </ul>
        <p>
          If an AI request spans several workspaces and any of them has AI disabled, the answer is
          produced locally rather than sending workspace content to a model provider.
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
          <strong>We hold no zero-retention agreement with Anthropic.</strong> Its published
          commercial policy describes deletion of API inputs and outputs within 30 days, subject to
          exceptions, and no model training without express permission. Content flagged by its
          safety systems may be retained longer, including for up to two years. These are provider
          policies, not a guarantee by Artifact Digital LLC. Disable workspace AI if you do not want
          workspace content sent to a model provider.
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
          <li>
            Sessions can be revoked individually or all at once, and a password change invalidates
            existing sessions.
          </li>
          <li>
            The audit log is append-only: the application&apos;s database role is not permitted to
            update or delete its rows.
          </li>
          <li>All traffic is served over HTTPS.</li>
        </ul>
        <p>
          <strong>No security measure is a guarantee.</strong> If we become aware of a personal-data
          breach affecting your data, we will notify you <strong>without undue delay</strong>,
          subject to applicable legal requirements, by email to your account address. Our notice
          will describe the information available to us, the likely effects, the steps we are
          taking, and any steps we recommend you take. We may provide information in stages as our
          investigation progresses. We will comply with any applicable notification deadlines and
          obligations.
        </p>
      </Section>

      <Section id="retention" heading="8. Retention">
        <p>
          The following describes our current retention practices. These practices do not override
          applicable legal requirements or your statutory rights.
        </p>

        <p className="font-medium text-body">Deleted automatically, on a daily sweep</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Expired sessions, and authentication tokens once they have been used or have expired.</li>
          <li>Completed background jobs, 30 days after they finish.</li>
          <li>Expired idempotency keys, and rate-limit counters.</li>
          <li>
            Security alerts are deleted <strong>365 days after they are acknowledged</strong>.
            Unacknowledged alerts are not automatically deleted. This is separate from the audit log
            below.
          </li>
        </ul>

        <p className="font-medium text-body">Not deleted automatically</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Business records are retained while stored in your workspace. Moving records to Trash
            does not permanently erase them.
          </li>
          <li>
            Records you delete go to Trash and stay there. They remain recoverable by you, and no job
            empties the Trash, so in practice they are kept indefinitely.
          </li>
          <li>
            Audit records are retained indefinitely by the current implementation; no automatic purge
            is configured. Requests concerning personal data in these records will be assessed under
            applicable law.
          </li>
        </ul>

        <p className="font-medium text-body">Deleting a workspace</p>
        <p>
          Workspace deletion is scheduled rather than immediate. The workspace becomes read-only for
          a <strong>7-day</strong> grace period during which the deletion can be cancelled, so an
          accidental or hostile deletion can be reversed before anything is destroyed. After the
          grace period it is carried out and cascades to that workspace&apos;s records.
        </p>

        <p className="font-medium text-body">Closing an account</p>
        <p>
          Account closure is not currently available inside the product. Send closure or deletion
          requests to{" "}
          <a
            href="mailto:privacy@tinycrm.biz"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            privacy@tinycrm.biz
          </a>
          . Requests involving shared workspaces may require coordination with other authorised
          users, so that one person&apos;s request does not improperly remove another
          person&apos;s data.
        </p>

        <p className="font-medium text-body">Point-in-time recovery</p>
        <p>
          Our configured database point-in-time recovery window is <strong>six hours</strong>. This
          is the period available for restoring the database to an earlier state; recovery is not
          guaranteed. That number is a recovery window, not a deletion guarantee — it does not mean
          data is erased six hours after you delete it.
        </p>
        <p>
          Separately, our database provider publishes a <strong>30-day</strong> retention period for
          its encrypted backups. Information permanently removed from the live database may remain in
          provider backups. We cannot remove individual records from those backups, and the published
          retention period is not a guarantee that every copy of a particular record will be erased
          exactly 30 days after a request.
        </p>
        <p>
          Application recovery is separate: records remain in Trash until permanently removed, and
          scheduled workspace deletion can be cancelled during its seven-day grace period.
        </p>
      </Section>

      <Section id="choices" heading="9. Your choices">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            You can export contacts, companies, deals, projects, opportunities and tasks as CSV, with
            up to <strong>50,000 rows per export</strong>, excluding records in Trash. Notes, activity
            history, uploaded files, tags and custom field values are not included in these exports.
            Files can be downloaded individually.
          </li>
          <li>Turn AI off per workspace, and keep every deterministic feature.</li>
          <li>Review and revoke sessions; enable two-factor authentication.</li>
          <li>Delete records, or a whole workspace.</li>
        </ul>
        <p>
          To make a request about your Tiny CRM account information, email{" "}
          <a
            href="mailto:privacy@tinycrm.biz"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            privacy@tinycrm.biz
          </a>
          . Depending on applicable law, you may have rights to access, correct, delete or receive a
          copy of your personal data, or to object to or restrict certain processing. You may also
          have the right to complain to your local data-protection authority. We may request
          information needed to verify your identity. We will respond within applicable legal
          deadlines and explain any lawful exception that prevents us from fulfilling a request.
        </p>
        <p>
          If your request concerns information a Tiny CRM customer has entered about you, contact
          that customer first. If you contact us directly, we will coordinate with the relevant
          customer and assist as required by law. Account closure is not currently available inside
          the product; requests can be sent to the email above. Some information may remain in
          backups or be retained for lawful purposes, as described in section 8.
        </p>
      </Section>

      <Section id="not-claimed" heading="10. What is deliberately not claimed">
        <p>Stating the limits plainly is more useful than implying more than is true:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>No certification is claimed — not SOC 2, not ISO 27001, not HIPAA.</li>
          <li>No zero-retention guarantee from any AI provider.</li>
          <li>No uptime or availability commitment.</li>
          <li>
            <strong>We do not maintain an independent off-provider backup.</strong> Our tested
            database recovery is held by the same provider within the same project. It is not
            protection against every form of account loss, project deletion or provider failure.
            Consider keeping your own exports, noting the export limitations described above.
          </li>
          <li>No recovery-time guarantee is offered.</li>
        </ul>
      </Section>

      <Section id="children" heading="11. Children">
        <p>Tiny CRM is a business tool and is not directed at children.</p>
      </Section>

      <Section id="changes" heading="12. Changes and contact">
        <p>
          If this notice changes materially, we will give at least{" "}
          <strong>30 days&apos; notice by email to your account address</strong>. Changes required
          sooner by law may take effect sooner, with notice as appropriate.
        </p>
        <p>
          Artifact Digital LLC, 178 N. Cuyamaca St., El Cajon, CA 92020, United States. Contact:{" "}
          <a
            href="mailto:privacy@tinycrm.biz"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            privacy@tinycrm.biz
          </a>
          . The governing-law and dispute provisions are set out in our terms of service and do not
          limit mandatory privacy rights.
        </p>
      </Section>
    </LegalPage>
  );
}
