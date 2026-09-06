"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { updateProfile } from "@/lib/actions/settings";

export function ProfileForm({
  name,
  jobTitle,
  timezone,
}: {
  name: string;
  jobTitle: string | null;
  timezone: string;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState({ name, jobTitle: jobTitle ?? "", timezone });
  const [pending, startTransition] = React.useTransition();
  const dirty =
    form.name !== name || form.jobTitle !== (jobTitle ?? "") || form.timezone !== timezone;

  return (
    <form
      className="space-y-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await updateProfile(form);
          if (result.ok) {
            toast.success("Profile updated");
            router.refresh();
          } else toast.error(result.error);
        });
      }}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Name" htmlFor="name">
          <Input
            id="name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>
        <Field label="Job title" htmlFor="jobTitle">
          <Input
            id="jobTitle"
            value={form.jobTitle}
            onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
            placeholder="Founder"
          />
        </Field>
        <Field label="Timezone" htmlFor="timezone" hint="Used for due dates and the daily brief.">
          <Input
            id="timezone"
            value={form.timezone}
            onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
          />
        </Field>
      </div>
      <Button type="submit" variant="brand" size="sm" loading={pending} disabled={!dirty}>
        Save changes
      </Button>
    </form>
  );
}
