import Link from "next/link";
import { Search, ShieldAlert } from "lucide-react";

import { listCustomers } from "@/lib/admin/customers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/surface";
import { PlanBadges } from "@/components/app/admin/plan-badges";

export const dynamic = "force-dynamic";

/**
 * The customer directory.
 *
 * Reads only. Every mutation lives on a customer's own page behind a
 * confirmation, so there is no control here that changes anything — a list is
 * the wrong place to act on one row by accident.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const page = Number.parseInt(params.page ?? "1", 10) || 1;

  const { rows, total, perPage } = await listCustomers({ query, page });
  const pages = Math.max(Math.ceil(total / perPage), 1);
  // A UrlObject rather than a built string: `Link` is typed against the route
  // map, and a template literal is just `string` to it.
  const href = (n: number) => ({
    pathname: "/admin" as const,
    query: { ...(query ? { q: query } : {}), page: String(n) },
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-body">Customers</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            {total.toLocaleString()} {total === 1 ? "account" : "accounts"}. Registered accounts,
            not subscriptions — a paid plan is shown where Stripe says there is one.
          </p>
        </div>
      </div>

      <Panel>
        <form className="flex items-center gap-2 border-b border-hairline p-3" action="/admin">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input
              name="q"
              defaultValue={query}
              placeholder="Search by name or email"
              aria-label="Search customers by name or email"
              className="pl-8"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" aria-label="Search customers">Search</Button>
          {query ? (
            <Button asChild variant="ghost" size="sm"><Link href="/admin">Clear</Link></Button>
          ) : null}
        </form>

        {rows.length === 0 ? (
          <EmptyState
            compact
            title={query ? "No accounts match that" : "No accounts yet"}
            description={
              query
                ? "Search matches a name or an email address, case-insensitively."
                : "Accounts appear here as people sign up."
            }
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/customers/${row.id}`}
                      className="truncate text-[13px] font-medium text-body hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.suspended ? (
                      <Badge tone="bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
                        <ShieldAlert className="size-3" aria-hidden /> Suspended
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[12px] text-muted">{row.email}</div>
                </div>

                <PlanBadges
                  billingLabel={row.billing.label}
                  billingDetail={row.billing.detail}
                  billingKind={row.billing.paidSubscription ? "paid" : row.billing.legacy ? "legacy" : "underlying"}
                  planStatus={row.planStatus}
                  underlyingPlan={row.billing.plan}
                  effectivePlan={row.effectivePlan}
                  grant={row.grant}
                  grantInForce={row.grantInForce}
                />

                <div className="hidden w-32 shrink-0 text-right text-[11.5px] text-faint sm:block">
                  {row.workspacesOwned} owned · {row.memberships} member
                </div>
                <div className="hidden w-24 shrink-0 text-right text-[11.5px] text-faint md:block">
                  {row.createdAt.toISOString().slice(0, 10)}
                </div>
              </li>
            ))}
          </ul>
        )}

        {pages > 1 ? (
          <div className="flex items-center justify-between border-t border-hairline px-4 py-2.5">
            <span className="text-[12px] text-muted">Page {page} of {pages}</span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(page - 1)}>Previous</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>Previous</Button>
              )}
              {page < pages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(page + 1)}>Next</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>Next</Button>
              )}
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
