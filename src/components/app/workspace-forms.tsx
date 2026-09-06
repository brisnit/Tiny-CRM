"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { createWorkspace } from "@/lib/actions/settings";
import { cn } from "@/lib/utils";

const COLORS = ["#068C28", "#2563EB", "#7C3AED", "#EA580C", "#0891B2", "#DB2777", "#CA8A04", "#0F766E"];

export function NewWorkspaceForm({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [color, setColor] = React.useState(COLORS[0]!);
  const [pending, startTransition] = React.useTransition();

  return (
    <form
      className="space-y-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await createWorkspace({ name, description, color });
          if (result.ok) {
            toast.success(`${result.data.name} created`);
            setName("");
            setDescription("");
            router.refresh();
          } else {
            toast.error(result.error, {
              action:
                result.code === "limit"
                  ? { label: "Upgrade", onClick: () => router.push("/settings/billing") }
                  : undefined,
            });
          }
        });
      }}
    >
      <Field label="Name" htmlFor="ws-name" required>
        <Input
          id="ws-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Artifact Digital"
          disabled={disabled}
          required
        />
      </Field>
      <Field label="What is this business?" htmlFor="ws-desc">
        <Textarea
          id="ws-desc"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Websites and brand systems for mission-driven organizations."
          disabled={disabled}
        />
      </Field>
      <Field label="Colour">
        <div className="flex flex-wrap gap-1.5">
          {COLORS.map((option) => (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => setColor(option)}
              className={cn(
                "size-7 rounded-lg transition-transform",
                color === option ? "ring-2 ring-offset-2 ring-offset-panel" : "hover:scale-110",
              )}
              style={{ background: option, ...(color === option ? { boxShadow: `0 0 0 2px ${option}` } : {}) }}
              aria-label={`Colour ${option}`}
            />
          ))}
        </div>
      </Field>
      <Button type="submit" variant="brand" size="sm" loading={pending} disabled={disabled || !name.trim()}>
        <Plus className="size-3.5" />
        Create workspace
      </Button>
    </form>
  );
}
