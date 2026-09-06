
import { PageShell } from "@/components/app/page-header";
import { SettingsNav } from "@/components/app/settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <PageShell>
      <div className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-body">Settings</h1>
        <p className="mt-1 text-[13px] text-muted">
          Better defaults over more switches — most of this is already set up for you.
        </p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageShell>
  );
}
