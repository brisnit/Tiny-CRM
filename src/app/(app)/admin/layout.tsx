import { requirePlatformAdmin } from "@/lib/admin/authorize";

/**
 * Every admin route passes through here.
 *
 * This is a convenience, not the control. A layout does not run for a server
 * action, so each action re-checks for itself; what this buys is that a page
 * added to this directory later cannot be reachable by forgetting a line. The
 * check throws `not_found` rather than `forbidden`, so an ordinary user
 * browsing to `/admin` sees what they would see for any URL that does not
 * exist — confirming the surface exists is itself a disclosure.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return <>{children}</>;
}
