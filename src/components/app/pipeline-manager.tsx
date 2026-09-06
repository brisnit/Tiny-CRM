"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/label";
import { createPipeline, createPipelineStage } from "@/lib/actions/settings";

/** Adds a stage to an existing pipeline, or creates a whole new pipeline. */
export function PipelineManager({
  pipelineId,
  workspaceId,
  createPipeline: isCreatePipeline,
}: {
  pipelineId?: string;
  workspaceId?: string;
  createPipeline?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<"deal" | "opportunity">("deal");
  const [stages, setStages] = React.useState("New Lead, Qualified, Proposal, Negotiation, Won");
  const [probability, setProbability] = React.useState("50");
  const [pending, startTransition] = React.useTransition();

  function submit() {
    startTransition(async () => {
      const result = isCreatePipeline
        ? await createPipeline(workspaceId!, {
            name,
            kind,
            stages: stages.split(",").map((s) => s.trim()).filter(Boolean),
          })
        : await createPipelineStage(pipelineId!, { name, probability: Number(probability) || 50 });

      if (result.ok) {
        toast.success(isCreatePipeline ? "Pipeline created" : "Stage added");
        setName("");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2.5 text-[12.5px] text-muted transition-colors hover:bg-sunken/60 hover:text-body"
      >
        <Plus className="size-3.5" />
        {isCreatePipeline ? "New pipeline" : "Add a stage"}
      </button>
    );
  }

  return (
    <div className="space-y-3 border-t border-hairline p-4">
      <Field label={isCreatePipeline ? "Pipeline name" : "Stage name"} required>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isCreatePipeline ? "Partnerships" : "Technical review"}
        />
      </Field>

      {isCreatePipeline ? (
        <>
          <Field label="Type">
            <OptionSelect
              value={kind}
              onValueChange={(v) => setKind(v as "deal" | "opportunity")}
              options={[
                { value: "deal", label: "Deals" },
                { value: "opportunity", label: "Opportunities" },
              ]}
            />
          </Field>
          <Field label="Stages" hint="Comma separated. The last one is treated as the win.">
            <Input value={stages} onChange={(e) => setStages(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="Base win rate" hint="Tiny CRM adjusts this by momentum when forecasting.">
          <Input
            inputMode="numeric"
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
            className="w-28"
          />
        </Field>
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="brand" onClick={submit} loading={pending} disabled={!name.trim()}>
          {isCreatePipeline ? "Create pipeline" : "Add stage"}
        </Button>
      </div>
    </div>
  );
}
