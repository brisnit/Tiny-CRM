"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/label";
import { createCustomField } from "@/lib/actions/settings";
import { CUSTOM_FIELD_TYPE, ENTITY_LABEL } from "@/lib/enums";

const ENTITIES = (["contact", "company", "deal", "project", "opportunity"] as const).map((value) => ({
  value,
  label: ENTITY_LABEL[value].one,
}));

export function FieldManager({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [entityType, setEntityType] = React.useState("contact");
  const [type, setType] = React.useState("text");
  const [options, setOptions] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const needsOptions = type === "dropdown" || type === "multiselect";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2.5 text-[12.5px] text-muted transition-colors hover:bg-sunken/60 hover:text-body"
      >
        <Plus className="size-3.5" />
        Add a custom field
      </button>
    );
  }

  return (
    <div className="space-y-3 border-t border-hairline p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Label" required className="sm:col-span-3">
          <Input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Carnegie Classification"
          />
        </Field>
        <Field label="Applies to">
          <OptionSelect value={entityType} onValueChange={setEntityType} options={ENTITIES} />
        </Field>
        <Field label="Type">
          <OptionSelect value={type} onValueChange={setType} options={CUSTOM_FIELD_TYPE.options} />
        </Field>
        {needsOptions ? (
          <Field label="Options" hint="Comma separated">
            <Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="One, Two, Three" />
          </Field>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="brand"
          loading={pending}
          disabled={!label.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await createCustomField(workspaceId, {
                entityType,
                label,
                type,
                options: needsOptions ? options.split(",").map((o) => o.trim()).filter(Boolean) : undefined,
              });
              if (result.ok) {
                setLabel("");
                setOptions("");
                setOpen(false);
                router.refresh();
              } else {
                toast.error(result.error, {
                  action:
                    result.category === "plan_limit"
                      ? { label: "Upgrade", onClick: () => router.push("/settings/billing") }
                      : undefined,
                });
              }
            })
          }
        >
          Create field
        </Button>
      </div>
    </div>
  );
}
