import Link from "next/link";

import { DraftBanner, LegalPage, NeedsDetail, Section } from "@/components/marketing/legal";
import { PLANS, PLAN_ORDER } from "@/lib/plans";

export const metadata = {
  title: "Terms",
  description: "The terms covering use of Tiny CRM, its plans and its limits.",
};

/**
 * Terms of service.
 *
 * The commercial facts here are read from `src/lib/plans.ts` rather than typed
 * out, so the terms cannot quote a price or a limit the product does not enforce.
 * That was a real failure mode on the marketing page, which advertised $14/month
 * and two features with no implementation for an entire plan generation.
 *
 * Everything that depends on a legal entity, a jurisdiction or a commercial policy
 * is marked with `NeedsDetail` instead of being invented.
 */
export default function TermsPage() {
  const sellable = PLAN_ORDER.map((id) => PLANS[id]);

  return (
    <LegalPage title="Terms of service" updated="2 October 2026" intro={<DraftBanner />}>
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
                <th className="py-2 pr-4 font-semibold">Price</th>
                <th className="py-2 pr-4 font-semibold">Contacts</th>
                <th className="py-2 pr-4 font-semibold">Workspaces</th>
                <th className="py-2 font-semibold">AI answers / month</th>
              </tr>
            </thead>
            <tbody>
              {sellable.map((plan) => (
                <tr key={plan.id} className="border-b border-hairline/60">
                  <td className="py-2 pr-4 text-body">{plan.name}</td>
                  <td className="py-2 pr-4">${(plan.priceCents / 100).toLocaleString()}{plan.priceCents > 0 ? "/mo" : ""}</td>
                  <td className="py-2 pr-4 tabular">{plan.limits.contacts.toLocaleString()}</td>
                  <td className="py-2 pr-4 tabular">{plan.limits.workspaces}</td>
                  <td className="py-2 tabular">{plan.limits.aiRequestsPerMonth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The full set of limits is shown on the <Link href="/#pricing" className="text-brand-600 hover:underline dark:text-brand-400">pricing page</Link> and
          in your billing settings, where current usage is displayed against each one. Limits are
          enforced on the server, so the figures you see are the figures that apply.
        </p>
        <p>
          <strong>Reaching a limit never deletes anything.</strong> It prevents creating more of that
          thing. If you move to a smaller plan and are above its ceiling, your existing records stay
          exactly where they are and remain readable, editable and exportable — you simply cannot add
          more until you are back under it.
        </p>
        <p>
          Prices and limits may change. How much notice is given before a change affects an existing
          subscriber is <NeedsDetail>a business decision</NeedsDetail>.
        </p>
      </Section>

      <Section id="billing" heading="4. Billing, cancellation and refunds">
        <ul className="list-disc space-y-1 pl-5">
          <li>Payments are processed by Stripe. Card details are entered on Stripe&apos;s pages and never reach our servers.</li>
          <li>Paid plans renew monthly until cancelled.</li>
          <li>You can change plan or cancel yourself, at any time, from billing settings.</li>
          <li>Cancelling takes effect at the end of the period you have already paid for. You keep your plan until then.</li>
          <li>If a payment fails we do not remove access immediately: Stripe retries, and your plan is retained while it does. Access ends only once the subscription is finally unpaid or cancelled.</li>
          <li>Changing plan mid-period is prorated by Stripe.</li>
        </ul>
        <p>
          Our refund policy is <NeedsDetail>a business decision</NeedsDetail>. Any applicable sales
          tax or VAT handling is <NeedsDetail>for legal review</NeedsDetail>.
        </p>
      </Section>

      <Section id="your-data" heading="5. Your data">
        <ul className="list-disc space-y-1 pl-5">
          <li>Your content remains yours. We claim no ownership of it.</li>
          <li>You can export everything you have entered to CSV at any time, without asking us, including after cancelling.</li>
          <li>Your content is not used to train any machine-learning model.</li>
          <li>How we handle your data is described in the <Link href="/privacy" className="text-brand-600 hover:underline dark:text-brand-400">privacy notice</Link>, which forms part of these terms.</li>
        </ul>
        <p>
          You are responsible for having a lawful basis to store information about the people you add,
          and for telling them if that is required where you are.
        </p>
      </Section>

      <Section id="acceptable-use" heading="6. Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Use the service to send unsolicited bulk messages, or to store data obtained unlawfully.</li>
          <li>Attempt to access another account or workspace, or to circumvent plan limits or rate limits.</li>
          <li>Probe, scan or load-test the service without written permission.</li>
          <li>Resell or sublicense the service without an agreement with us.</li>
        </ul>
        <p>
          We may suspend an account that puts the service or other customers at risk. Notice periods
          and any appeal route are <NeedsDetail>a business decision</NeedsDetail>.
        </p>
      </Section>

      <Section id="ai-terms" heading="7. Tiny AI specifically">
        <ul className="list-disc space-y-1 pl-5">
          <li>AI is controlled per workspace. With AI disabled, no workspace content is sent to any model provider, and every built-in feature keeps working.</li>
          <li>Each plan includes a monthly allowance of model answers. Only requests that reach a paid provider count; the built-in engine never does.</li>
          <li>When the allowance is spent, the built-in engine keeps working and the allowance resets at the start of the next month.</li>
          <li>Model output can be wrong. Check anything you intend to act on; we do not warrant that an answer is accurate.</li>
          <li>We make no zero-retention claim on behalf of the model provider. See the privacy notice.</li>
        </ul>
      </Section>

      <Section id="availability" heading="8. Availability">
        <p>
          The service is provided as-is, with no uptime commitment and no service-level agreement. We
          take backups and have tested restoring them, but offer no recovery-time guarantee. Keeping
          your own exports is sensible, and export is always available to you.
        </p>
        <p>
          If an availability commitment is to be offered, it is{" "}
          <NeedsDetail>a business decision</NeedsDetail>.
        </p>
      </Section>

      <Section id="liability" heading="9. Warranties and liability">
        <p>
          The warranty disclaimer, limitation of liability, indemnities and their caps are{" "}
          <NeedsDetail>for legal review</NeedsDetail> — these clauses determine real financial
          exposure and should not be drafted from a template or by an assistant.
        </p>
      </Section>

      <Section id="termination" heading="10. Ending the agreement">
        <ul className="list-disc space-y-1 pl-5">
          <li>You may stop using the service and delete your account at any time.</li>
          <li>Deleting a workspace is scheduled rather than immediate, so it can be reversed during a grace period before anything is destroyed.</li>
          <li>Export your data before closing your account; afterwards we cannot recover it for you.</li>
        </ul>
        <p>
          The retention period for any residual data after closure is{" "}
          <NeedsDetail>a business decision</NeedsDetail>.
        </p>
      </Section>

      <Section id="changes" heading="11. Changes, law and contact">
        <p>
          If these terms change materially we will say so in the product. The notice period is{" "}
          <NeedsDetail>a business decision</NeedsDetail>.
        </p>
        <p>
          Governing law and the courts with jurisdiction are{" "}
          <NeedsDetail>for legal review</NeedsDetail> — a California business address does not by
          itself choose California law. Contact for legal notices:{" "}
          <a href="mailto:privacy@tinycrm.biz" className="text-brand-600 hover:underline dark:text-brand-400">
            privacy@tinycrm.biz
          </a>.
        </p>
      </Section>
    </LegalPage>
  );
}
