import { requirePlatformAdminPage } from "@/lib/admin/authorize";

/**
 * Every admin route passes through here.
 *
 * This is a convenience, not the control. A layout does not run for a server
 * action, so each action re-checks for itself; what this buys is that a page
 * added to this directory later cannot be reachable by forgetting a line. The
 * The refusal answers 404 rather than 403, because confirming the surface
 * exists is itself a disclosure.
 *
 * It uses the *page* variant deliberately. The action variant throws an
 * `AppError`, and a layout has nothing to catch it, so the refusal escaped to
 * Next's `onRequestError` hook: `/admin` answered **500 with an empty body**
 * and raised an application-error alert (Sentry TINY-CRM-8) every time an
 * ordinary account opened it. The comment here previously claimed the visitor
 * "sees what they would see for any URL that does not exist"; they did not,
 * and nothing tested the status until now.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdminPage();
  return <>{children}</>;
}
