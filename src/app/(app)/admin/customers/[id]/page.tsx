import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, ShieldAlert } from "lucide-react";

import { requirePlatformAdmin } from "@/lib/admin/authorize";
import { administrativeAudit, customerDetail } from "@/lib/admin/customers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { PlanBadges } from "@/components/app/admin/plan-badges";
import { CustomerControls } from "@/components/app/admin/customer-controls";
import { stripeDashboardUrls } from "@/lib/admin/stripe-links";

export const dynamic = "force-dynamic";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  const { id } = await params;
  const customer = await customerDetail(id);
  if (!customer) notFound();

  const entries = (await administrativeAudit(200)).filter((e) => e.entityId === customer.id);
  const stripe = stripeDashboardUrls(customer.billing.customerId);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <Button asChild variant="ghost" size="sm">
        <Link href="/admin"><ArrowLeft className="size-3.5" aria-hidden /> All customers</Link>
      </Button>

      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[17px] font-semibold text-body">{customer.name}</h1>
              {customer.suspended ? (
                <Badge tone="bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
                  <ShieldAlert className="size-3" aria-hidden /> Suspended
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-[13px] text-muted">{customer.email}</p>
            <p className="mt-1 text-[12px] text-faint">
              Registered {customer.createdAt.toISOString().slice(0, 10)}
              {customer.emailVerifiedAt ? " · email verified" : " · email not verified"}
              {customer.lastSeenAt ? ` · last seen ${customer.lastSeenAt.toISOString().slice(0, 10)}` : ""}
            </p>
            {customer.suspended && customer.suspendedReason ? (
              <p className="mt-1 text-[12px] text-rose-600 dark:text-rose-400">
                Suspended: {customer.suspendedReason}
              </p>
            ) : null}
          </div>
          <PlanBadges
            billingLabel={customer.billingState.label}
            billingDetail={customer.billingState.detail}
            billingKind={
              customer.billingState.paidSubscription
                ? "paid"
                : customer.billingState.legacy
                  ? "legacy"
                  : "underlying"
            }
            planStatus={customer.billing.planStatus}
            underlyingPlan={customer.entitlement.underlying}
            effectivePlan={customer.entitlement.effective}
            grant={customer.entitlement.grant}
            grantInForce={customer.entitlement.grantInForce}
          />
        </div>

        <div className="border-t border-hairline p-4">
          <CustomerControls
            userId={customer.id}
            email={customer.email}
            suspended={customer.suspended}
            suspendedReason={customer.suspendedReason}
            grant={customer.entitlement.grant}
            isSelf={customer.id === admin.identity.id}
          />
        </div>
      </Panel>

      {/* Billing and entitlement, deliberately side by side and labelled apart. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <PanelHeader
            title={
              customer.billingState.paidSubscription
                ? "Paid through Stripe"
                : customer.billingState.legacy
                  ? "Legacy entitlement — no subscription"
                  : "Billing"
            }
          />
          <dl className="space-y-2 border-t border-hairline p-4 text-[13px]">
            <Row label="Stored plan" value={customer.billing.storedPlan} />
            <Row label="Status" value={customer.billing.planStatus} />
            <Row
              label="Renews / ends"
              value={customer.billing.renewsAt?.toISOString().slice(0, 10) ?? "—"}
            />
            <Row label="Stripe customer" value={customer.billing.customerId ?? "none"} mono />
          </dl>
          <div className="border-t border-hairline px-4 py-3">
            {stripe ? (
              <Button asChild variant="outline" size="sm">
                <a href={stripe.customer} target="_blank" rel="noreferrer noopener">
                  Open in Stripe <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </Button>
            ) : (
              <p className="text-[12px] text-faint">
                No Stripe customer. This account has never transacted.
              </p>
            )}
            <p className="mt-2 text-[12px] text-faint">
              Charges, refunds, cancellation and plan switching are done in Stripe, not here.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Effective entitlement" />
          <dl className="space-y-2 border-t border-hairline p-4 text-[13px]">
            <Row label="Underlying plan" value={customer.entitlement.underlying} />
            <Row
              label="Complimentary grant"
              value={
                customer.entitlement.grant
                  ? customer.entitlement.grant.plan +
                    (customer.entitlement.grantInForce ? "" : " (not adding anything)")
                  : "none"
              }
            />
            <Row
              label="Grant expires"
              value={
                customer.entitlement.grant
                  ? (customer.entitlement.grant.expiresAt?.toISOString().slice(0, 10) ?? "no expiry")
                  : "—"
              }
            />
            <Row label="Effective plan" value={customer.entitlement.effective} strong />
          </dl>
          <p className="border-t border-hairline px-4 py-3 text-[12px] text-faint">
            A grant only ever adds: the effective plan is the stronger of the two, so
            complimentary access can never reduce what an account can do, and legacy
            entitlements are never overridden.
          </p>
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <PanelHeader title="Workspaces owned" />
          {customer.owned.length === 0 ? (
            <EmptyState compact title="None" description="This account owns no workspaces." />
          ) : (
            <ul className="divide-y divide-hairline border-t border-hairline">
              {customer.owned.map((w) => (
                <li key={w.id} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                  <span className="truncate text-body">{w.name}</span>
                  <span className="text-[12px] text-faint">{w.members} members</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-hairline px-4 py-3 text-[12px] text-faint">
            These workspaces take their plan from <em>this</em> account, because the owner is who
            pays.
          </p>
        </Panel>

        <Panel>
          <PanelHeader title="Member of" />
          {customer.memberOf.length === 0 ? (
            <EmptyState compact title="None" description="This account belongs to no one else's workspace." />
          ) : (
            <ul className="divide-y divide-hairline border-t border-hairline">
              {customer.memberOf.map((w) => (
                <li key={w.id} className="px-4 py-2.5 text-[13px]">
                  <div className="flex items-center justify-between">
                    <span className="truncate text-body">{w.name}</span>
                    <span className="text-[12px] text-faint">{w.role}</span>
                  </div>
                  <div className="truncate text-[11.5px] text-faint">
                    owned by {w.ownerEmail} · {w.ownerPlan}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-hairline px-4 py-3 text-[12px] text-faint">
            These take their plan from their <em>own</em> owner, shown above — not from this
            account.
          </p>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Grant history" />
        {customer.grants.length === 0 ? (
          <EmptyState compact title="No grants" description="This account has never been given complimentary access." />
        ) : (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {customer.grants.map((g) => (
              <li key={g.id} className="px-4 py-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body">
                    {g.plan}
                    {g.revokedAt ? " (revoked)" : g.expiresAt && g.expiresAt < new Date() ? " (expired)" : " (active)"}
                  </span>
                  <span className="text-[11.5px] text-faint">
                    {g.grantedAt.toISOString().slice(0, 10)}
                    {g.expiresAt ? ` → ${g.expiresAt.toISOString().slice(0, 10)}` : ""}
                  </span>
                </div>
                <div className="text-[12px] text-muted">{g.reason}</div>
                {g.revokedReason ? (
                  <div className="text-[11.5px] text-faint">Revoked: {g.revokedReason}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Administrative history" />
        {entries.length === 0 ? (
          <EmptyState
            compact
            title="Nothing yet"
            description="Administrative changes to this account will appear here."
          />
        ) : (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {entries.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body">{e.summary}</span>
                  <span className="shrink-0 text-[11.5px] text-faint">
                    {e.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                <div className="text-[11.5px] text-faint">by {e.actorEmail ?? "unknown"}</div>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-hairline px-4 py-3 text-[12px] text-faint">
          Shows administrative actions taken by you. Entries written by the Stripe webhook carry
          neither an actor nor a workspace and are not readable here — see docs/ADMIN-PANEL.md.
        </p>
      </Panel>
    </div>
  );
}

function Row({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[12px] text-faint">{label}</dt>
      <dd
        className={[
          "truncate text-right",
          mono ? "font-mono text-[11.5px]" : "",
          strong ? "font-medium text-body" : "text-muted",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
