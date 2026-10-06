import Link from "next/link";

import { DraftBanner, LegalPage, Section } from "@/components/marketing/legal";
import { legalEffectiveDate } from "@/lib/legal";
import {
  PLANS,
  PLAN_ORDER,
  PRE_STRIPE_FREE_AI_ALLOWANCE,
  PRICING_CUTOVER_PERIOD,
  UNLIMITED,
} from "@/lib/plans";

export const metadata = {
  title: "Terms",
  description: "The terms covering use of Tiny CRM, its plans and its limits.",
};

/** "2026-10" → "October 2026", so the page never prints a period key at a reader. */
function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  return `${name} ${year}`;
}

/**
 * Terms of service.
 *
 * Revised 5 October 2026 against the owner-approved review copy. The approved
 * decisions written in here are the liability cap — the greater of $100 or the
 * fees paid in the preceding twelve months, with exceptions and mandatory rights
 * preserved — and California law with San Diego County venue, also preserving
 * mandatory rights.
 *
 * Tax is stated as current behaviour and deliberately NOT as a settled
 * obligation. The open questions behind it are in docs/legal/REVIEW-NOTES.md,
 * which is internal and is not rendered here.
 *
 * Prices, limits, the cutover month and the legacy Free allowance are all read
 * from src/lib/plans.ts rather than typed out, so this page cannot quote a figure
 * the product does not enforce. That was a real failure mode on the marketing
 * page, which advertised $14/month and two features with no implementation for an
 * entire plan generation.
 *
 * Nothing here describes the page as lawyer-reviewed or legally certified,
 * because it is neither.
 */
export default function TermsPage() {
  const sellable = PLAN_ORDER.map((id) => PLANS[id]);
  const limit = (value: number) => (value === UNLIMITED ? "Unlimited" : value.toLocaleString());

  return (
    <LegalPage title="Terms of service" updated={legalEffectiveDate()} intro={<DraftBanner />}>
      <Section id="parties" heading="1. Who these terms are between">
        <p>
          These terms are between you and <strong>Artifact Digital LLC</strong>, 178 N. Cuyamaca St.,
          El Cajon, CA 92020, United States (&ldquo;we&rdquo;, &ldquo;us&rdquo;), covering your use of
          Tiny CRM.
        </p>
        <p>
          By creating an account you accept them. If you are accepting on behalf of an organisation,
          you confirm you are authorised to do so.
        </p>
      </Section>

      <Section id="service" heading="2. What the service does">
        <p>
          Tiny CRM stores and organises contacts, companies, deals, opportunities, projects, tasks
          and notes, and offers two distinct kinds of assistance:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            A <strong>built-in engine</strong> that computes relationship scores, deal momentum,
            project health, duplicate detection, hygiene checks and a daily brief. It runs locally,
            is unmetered on every plan, and needs no AI model.
          </li>
          <li>
            <strong>Tiny AI</strong>, which answers open-ended questions in prose using a
            third-party model. This is metered, because each request costs us money to serve.
          </li>
        </ul>
      </Section>

      <Section id="plans" heading="3. Plans, prices and limits">
        <p>Prices are in US dollars and billed monthly. Current plans:</p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-left text-body">
                <th className="py-2 pr-4 font-semibold">Plan</th>
                <th className="py-2 pr-4 font-semibold">Monthly price</th>
                <th className="py-2 pr-4 font-semibold">Contacts</th>
                <th className="py-2 pr-4 font-semibold">Workspaces</th>
                <th className="py-2 pr-4 font-semibold">Seats</th>
                <th className="py-2 font-semibold">AI answers / month</th>
              </tr>
            </thead>
            <tbody>
              {sellable.map((plan) => (
                <tr key={plan.id} className="border-b border-hairline/60">
                  <td className="py-2 pr-4 text-body">{plan.name}</td>
                  <td className="py-2 pr-4">${(plan.priceCents / 100).toLocaleString()}</td>
                  <td className="py-2 pr-4 tabular">{limit(plan.limits.contacts)}</td>
                  <td className="py-2 pr-4 tabular">{limit(plan.limits.workspaces)}</td>
                  <td className="py-2 pr-4 tabular">{limit(plan.limits.seats)}</td>
                  <td className="py-2 tabular">{limit(plan.limits.aiRequestsPerMonth)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {PRICING_CUTOVER_PERIOD !== null &&
        PRE_STRIPE_FREE_AI_ALLOWANCE > PLANS.free.limits.aiRequestsPerMonth ? (
          <p>
            For <strong>{monthName(PRICING_CUTOVER_PERIOD)}</strong>, Free accounts retain a
            temporary allowance of {PRE_STRIPE_FREE_AI_ALLOWANCE} AI answers. The standing allowance
            is {PLANS.free.limits.aiRequestsPerMonth} per month thereafter. Original Lifetime
            entitlements remain preserved and are not offered for new purchase.
          </p>
        ) : (
          <p>
            Original Lifetime entitlements remain preserved and are not offered for new purchase.
          </p>
        )}
        <p>
          Current plan limits and usage are shown on the{" "}
          <Link href="/#pricing" className="text-brand-600 hover:underline dark:text-brand-400">
            pricing page
          </Link>{" "}
          and in billing settings. Server-side enforcement applies.
        </p>
        <p>
          <strong>Reaching a record limit does not delete existing records.</strong> It prevents
          creating more of that record type. If you move to a smaller plan and exceed a ceiling,
          existing records remain readable, editable and exportable within the export limitations
          described in the privacy notice; you cannot add more until you are within the limit.
        </p>
        <p>
          Prices and limits may change. Before a change applies to an existing subscription we will
          give at least <strong>30 days&apos; notice by email to your account address</strong>, and
          you can cancel before it takes effect — see{" "}
          <Link href="#changes" className="text-brand-600 hover:underline dark:text-brand-400">
            section 11
          </Link>
          .
        </p>
      </Section>

      <Section id="billing" heading="4. Billing, cancellation and refunds">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Payments are processed by Stripe. Card details are entered on Stripe&apos;s pages and
            never reach our servers.
          </li>
          <li>Paid plans renew monthly until cancelled.</li>
          <li>You can change plan or cancel yourself, at any time, from billing settings.</li>
          <li>
            Cancelling takes effect at the end of the period you have already paid for. You keep
            your plan until then.
          </li>
          <li>
            A failed payment does not immediately remove access. Stripe may retry payment; plan
            access can end when the subscription becomes unpaid or is cancelled.
          </li>
        </ul>
        <p>
          <strong>Cancellation.</strong> If you cancel, no refund or credit is issued for unused
          time. Your plan continues until the end of the period you have already paid for, and the
          account then moves to Free.
        </p>
        <p>
          <strong>Changing plan mid-period is prorated, and the direction matters.</strong> A
          downgrade produces a credit for the time you did not use at the higher rate. An upgrade
          produces an additional charge for the remainder of the period. In both cases the
          adjustment appears on your <em>next invoice</em> rather than being charged or refunded
          immediately.
        </p>
        <p>If you were charged in error, contact us and we will refund it.</p>
        <p>
          <strong>Taxes.</strong> Subscription prices are stated in USD. We do not currently add
          sales tax or VAT at checkout, so the subscription charge is the displayed plan price. If
          we begin collecting applicable taxes, they will be shown before you complete a purchase.
          Our 30-day notice policy applies to increases in the subscription price itself; it does
          not delay tax collection or other changes required by law.
        </p>
      </Section>

      <Section id="your-data" heading="5. Your data">
        <p>
          Your content remains yours. We claim no ownership of it. You authorise us to store and
          process it as needed to provide the service and follow your instructions, subject to
          applicable law.
        </p>
        <p>
          You can export contacts, companies, deals, projects, opportunities and tasks as CSV,
          including after cancelling a paid plan, with up to <strong>50,000 rows per export</strong>{" "}
          and excluding records in Trash. Notes, activity history, uploaded files, tags and custom
          field values are not included; see the{" "}
          <Link href="/privacy" className="text-brand-600 hover:underline dark:text-brand-400">
            privacy notice
          </Link>{" "}
          for details.
        </p>
        <p>
          We do not use your CRM content to train machine-learning models, or sell or share it for
          advertising. AI-provider handling is described in the privacy notice.
        </p>
        <p>
          How we handle your data is described in the{" "}
          <Link href="/privacy" className="text-brand-600 hover:underline dark:text-brand-400">
            privacy notice
          </Link>
          , which forms part of these terms.
        </p>
        <p>
          You are responsible for having a lawful basis to store information about the people you
          add, and for telling them if that is required where you are.
        </p>
      </Section>

      <Section id="acceptable-use" heading="6. Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Use the service to send unsolicited bulk messages, or to store data obtained unlawfully.
          </li>
          <li>
            Attempt to access another account or workspace, or to circumvent plan limits or rate
            limits.
          </li>
          <li>Probe, scan or load-test the service without written permission.</li>
          <li>Resell or sublicense the service without an agreement with us.</li>
        </ul>
        <p>
          <strong>Suspension.</strong> If an account puts the service or other customers at risk —
          through abuse, an attempt to reach another account or workspace, or anything unlawful — we
          may suspend it <strong>immediately and without advance notice</strong>. We will email the
          account address explaining the reason, where we are legally permitted to say.
        </p>
        <p>
          <strong>Appeals.</strong> Write to{" "}
          <a
            href="mailto:privacy@tinycrm.biz"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            privacy@tinycrm.biz
          </a>
          . We aim to respond within five business days. Suspension is not deletion: your records
          are not removed, and a suspension that we got wrong is reversible.
        </p>
      </Section>

      <Section id="ai-terms" heading="7. Tiny AI specifically">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            AI is controlled per workspace. With AI disabled, no workspace content is sent to any
            model provider, and every built-in feature keeps working.
          </li>
          <li>
            Each plan includes a monthly allowance of model answers. Only requests that reach a paid
            provider count; the built-in engine never does.
          </li>
          <li>
            When the allowance is spent, the built-in engine keeps working and the allowance resets
            at the start of the next month.
          </li>
          <li>
            Model output can be wrong. Check anything you intend to act on; we do not warrant that
            an answer is accurate.
          </li>
          <li>
            We make no zero-retention claim on behalf of the model provider. See the privacy notice.
          </li>
        </ul>
      </Section>

      <Section id="availability" heading="8. Availability">
        <p>
          The service is provided as available, with no uptime commitment, service-level agreement or
          recovery-time guarantee. Database recovery has been tested within our configured six-hour
          window and is held by the same provider in the same project. It is not an independent
          backup. Consider keeping your own exports, noting the limitations described in the privacy
          notice.
        </p>
      </Section>

      <Section id="liability" heading="9. Warranties and liability">
        <p>
          To the extent permitted by applicable law, the service is provided &ldquo;as is&rdquo; and
          &ldquo;as available&rdquo;, without warranties of any kind, whether express or implied,
          including implied warranties of merchantability, fitness for a particular purpose or
          non-infringement.
        </p>
        <p>
          <strong>Limitation of liability.</strong> To the extent permitted by applicable law,
          Artifact Digital LLC&apos;s total liability to you for all claims arising from or relating
          to Tiny CRM or these terms will not exceed the greater of <strong>$100 USD</strong> or the
          total fees you paid us for Tiny CRM during the <strong>12 months</strong> immediately
          preceding the event giving rise to the claim.
        </p>
        <p>
          This limit does not apply to fraud, willful misconduct, or any liability that applicable
          law does not allow us to limit. Nothing in these terms excludes or restricts your
          mandatory statutory rights.
        </p>
      </Section>

      <Section id="termination" heading="10. Ending the agreement">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            You may stop using the service at any time, and cancel a paid plan yourself from billing
            settings.
          </li>
          <li>
            You can delete individual records, and whole workspaces. Deleting a workspace is
            scheduled rather than immediate, so it can be reversed during a 7-day grace period
            before anything is destroyed.
          </li>
          <li>
            Account closure is not currently available inside the product. Send closure requests to{" "}
            <a
              href="mailto:privacy@tinycrm.biz"
              className="text-brand-600 hover:underline dark:text-brand-400"
            >
              privacy@tinycrm.biz
            </a>
            .
          </li>
          <li>
            Export your data before you stop using the service. What an export covers, and what it
            does not, is set out in the privacy notice.
          </li>
        </ul>
        <p>
          Our current retention practices are described in{" "}
          <Link
            href="/privacy#retention"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            section 8 of the privacy notice
          </Link>
          . Those practices do not override applicable legal requirements or your statutory rights.
        </p>
      </Section>

      <Section id="changes" heading="11. Changes, law and contact">
        <p>
          We will give at least <strong>30 days&apos; notice by email to your account address</strong>{" "}
          before a subscription price increase or a material change to these terms applies to an
          existing subscription. You can cancel before it takes effect. Changes required sooner by
          law may take effect sooner, with notice as appropriate.
        </p>
        <p>
          <strong>Governing law and disputes.</strong> These terms are governed by California law,
          excluding its conflict-of-law rules. Unless applicable law requires otherwise, disputes
          arising from these terms or your use of Tiny CRM will be brought in the state or federal
          courts located in San Diego County, California. Nothing in these terms deprives you of
          mandatory protections under applicable law, or of any right to bring a claim in another
          court where that right cannot lawfully be restricted. Contact for legal notices:{" "}
          <a
            href="mailto:privacy@tinycrm.biz"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            privacy@tinycrm.biz
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
