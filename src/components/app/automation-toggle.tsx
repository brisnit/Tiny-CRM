"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Switch } from "@/components/ui/controls";
import { setAutomationEnabled } from "@/lib/actions/automations";
import { useSyncedState } from "@/lib/hooks";

export function AutomationToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useSyncedState(enabled);
  const [pending, startTransition] = React.useTransition();

  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2">
      <span className="text-[12px] text-muted">{on ? "Enabled" : "Paused"}</span>
      <Switch
        checked={on}
        disabled={pending}
        onCheckedChange={(next) => {
          setOn(next);
          startTransition(async () => {
            const result = await setAutomationEnabled(id, next);
            if (!result.ok) {
              setOn(!next);
              toast.error(result.error);
            } else {
              toast.success(next ? "Automation enabled" : "Automation paused");
              router.refresh();
            }
          });
        }}
      />
    </label>
  );
}
