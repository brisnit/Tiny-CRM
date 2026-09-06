"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Building2, CalendarDays, CheckSquare, FileText, FolderKanban, Landmark, Target, Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { OptionSelect } from "@/components/ui/select";
import { RecordPicker } from "@/components/app/record-picker";
import { cn } from "@/lib/utils";
import { PROJECT_PRIORITY, RELATIONSHIP_TYPE, TASK_PRIORITY } from "@/lib/enums";
import { createContact } from "@/lib/actions/contacts";
import { createCompany } from "@/lib/actions/companies";
import { createProject } from "@/lib/actions/projects";
import { createDeal } from "@/lib/actions/deals";
import { createTask } from "@/lib/actions/tasks";
import { createNote } from "@/lib/actions/notes";
import { createOpportunity } from "@/lib/actions/opportunities";
import { logTimelineEntry } from "@/lib/actions/activities";
import type { ActionResult } from "@/lib/actions/base";

export type QuickAddKind =
  | "contact" | "company" | "deal" | "project" | "task" | "note" | "opportunity" | "meeting";

export type QuickAddContext = {
  workspaces: { id: string; name: string }[];
  defaultWorkspaceId: string | null;
  pipelines: { id: string; name: string; workspaceId: string; stages: { id: string; name: string }[] }[];
  statuses: { id: string; name: string; workspaceId: string }[];
  /** Pre-links the new record when quick-add is opened from a record page. */
  prefill?: Partial<Record<"contactId" | "companyId" | "dealId" | "projectId" | "opportunityId", string>>;
};

const KINDS: { kind: QuickAddKind; label: string; icon: React.ElementType; hint: string }[] = [
  { kind: "task", label: "Task", icon: CheckSquare, hint: "Something to do" },
  { kind: "contact", label: "Contact", icon: Users, hint: "A person" },
  { kind: "company", label: "Company", icon: Building2, hint: "An organization" },
  { kind: "deal", label: "Deal", icon: Target, hint: "Revenue in play" },
  { kind: "project", label: "Project", icon: FolderKanban, hint: "Work with a home" },
  { kind: "note", label: "Note", icon: FileText, hint: "Capture something" },
  { kind: "opportunity", label: "Opportunity", icon: Landmark, hint: "RFP or solicitation" },
  { kind: "meeting", label: "Meeting", icon: CalendarDays, hint: "Log what happened" },
];

export function QuickAddDialog({
  open,
  onOpenChange,
  context,
  initialKind = "task",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: QuickAddContext;
  initialKind?: QuickAddKind;
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<QuickAddKind>(initialKind);
  const [pending, startTransition] = React.useTransition();
  const [workspaceId, setWorkspaceId] = React.useState(
    context.defaultWorkspaceId ?? context.workspaces[0]?.id ?? "",
  );
  // Mounted only while open (see AppShell), so initial state is always fresh —
  // no effect is needed to reset the form between openings.
  const [form, setForm] = React.useState<Record<string, string | null>>({ ...context.prefill });

  const set = (key: string) => (value: string | null) => setForm((f) => ({ ...f, [key]: value }));

  const pipelines = context.pipelines.filter((p) => p.workspaceId === workspaceId);
  const dealPipeline = pipelines[0];

  function submit() {
    if (!workspaceId) {
      toast.error("Choose a workspace first.");
      return;
    }
    startTransition(async () => {
      const result = await runCreate(kind, workspaceId, form, context);
      if (!result) return;
      if (result.ok) {
        toast.success(`${labelFor(kind)} created`, {
          description: (result.data as { name?: string; title?: string })?.name
            ?? (result.data as { title?: string })?.title,
        });
        onOpenChange(false);
        setForm({});
        router.refresh();
      } else {
        toast.error(result.error, {
          action:
            result.category === "plan_limit"
              ? { label: "Upgrade", onClick: () => router.push("/settings/billing") }
              : undefined,
        });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" className="p-0">
        <DialogHeader>
          <DialogTitle>Quick add</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5 border-b border-hairline px-6 py-3">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => setKind(k.kind)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                kind === k.kind
                  ? "border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300"
                  : "border-hairline text-muted hover:bg-sunken hover:text-body",
              )}
            >
              <k.icon className="size-3.5" />
              {k.label}
            </button>
          ))}
        </div>

        <DialogBody className="space-y-4">
          {context.workspaces.length > 1 ? (
            <Field label="Workspace">
              <OptionSelect
                value={workspaceId}
                onValueChange={setWorkspaceId}
                options={context.workspaces.map((w) => ({ value: w.id, label: w.name }))}
              />
            </Field>
          ) : null}

          <QuickAddFields
            kind={kind}
            form={form}
            set={set}
            workspaceId={workspaceId}
            dealPipeline={dealPipeline}
            statuses={context.statuses.filter((s) => s.workspaceId === workspaceId)}
          />
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="brand" onClick={submit} loading={pending}>
            Create {labelFor(kind).toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuickAddFields({
  kind, form, set, workspaceId, dealPipeline, statuses,
}: {
  kind: QuickAddKind;
  form: Record<string, string | null>;
  set: (key: string) => (value: string | null) => void;
  workspaceId: string;
  dealPipeline?: QuickAddContext["pipelines"][number];
  statuses: { id: string; name: string }[];
}) {
  const linkFields = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Contact">
        <RecordPicker type="contact" value={form.contactId ?? null} onChange={set("contactId")} workspaceId={workspaceId} emptyLabel="No contact" />
      </Field>
      <Field label="Company">
        <RecordPicker type="company" value={form.companyId ?? null} onChange={set("companyId")} workspaceId={workspaceId} emptyLabel="No company" />
      </Field>
      <Field label="Project">
        <RecordPicker type="project" value={form.projectId ?? null} onChange={set("projectId")} workspaceId={workspaceId} emptyLabel="No project" />
      </Field>
      <Field label="Deal">
        <RecordPicker type="deal" value={form.dealId ?? null} onChange={set("dealId")} workspaceId={workspaceId} emptyLabel="No deal" />
      </Field>
    </div>
  );

  switch (kind) {
    case "task":
      return (
        <>
          <Field label="Task" required>
            <Input autoFocus placeholder="Follow up with…" value={form.title ?? ""} onChange={(e) => set("title")(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Due">
              <Input type="date" value={form.dueAt ?? ""} onChange={(e) => set("dueAt")(e.target.value)} />
            </Field>
            <Field label="Priority">
              <OptionSelect value={form.priority ?? "medium"} onValueChange={set("priority")} options={TASK_PRIORITY.options} />
            </Field>
          </div>
          {linkFields}
        </>
      );

    case "contact":
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" required>
              <Input autoFocus value={form.firstName ?? ""} onChange={(e) => set("firstName")(e.target.value)} />
            </Field>
            <Field label="Last name">
              <Input value={form.lastName ?? ""} onChange={(e) => set("lastName")(e.target.value)} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email ?? ""} onChange={(e) => set("email")(e.target.value)} />
            </Field>
            <Field label="Job title">
              <Input value={form.jobTitle ?? ""} onChange={(e) => set("jobTitle")(e.target.value)} />
            </Field>
            <Field label="Company">
              <RecordPicker type="company" value={form.companyId ?? null} onChange={set("companyId")} workspaceId={workspaceId} emptyLabel="No company" />
            </Field>
            <Field label="Relationship">
              <OptionSelect value={form.relationshipType ?? "prospect"} onValueChange={set("relationshipType")} options={RELATIONSHIP_TYPE.options} />
            </Field>
          </div>
        </>
      );

    case "company":
      return (
        <>
          <Field label="Company name" required>
            <Input autoFocus value={form.name ?? ""} onChange={(e) => set("name")(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Website">
              <Input placeholder="https://" value={form.website ?? ""} onChange={(e) => set("website")(e.target.value)} />
            </Field>
            <Field label="Industry">
              <Input value={form.industry ?? ""} onChange={(e) => set("industry")(e.target.value)} />
            </Field>
          </div>
        </>
      );

    case "deal":
      return (
        <>
          <Field label="Deal name" required>
            <Input autoFocus value={form.name ?? ""} onChange={(e) => set("name")(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Value">
              <Input inputMode="decimal" placeholder="0" value={form.valueCents ?? ""} onChange={(e) => set("valueCents")(e.target.value)} />
            </Field>
            <Field label="Expected close">
              <Input type="date" value={form.expectedCloseAt ?? ""} onChange={(e) => set("expectedCloseAt")(e.target.value)} />
            </Field>
            <Field label="Stage">
              <OptionSelect
                value={form.stageId ?? dealPipeline?.stages[0]?.id ?? null}
                onValueChange={set("stageId")}
                options={(dealPipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
            <Field label="Company">
              <RecordPicker type="company" value={form.companyId ?? null} onChange={set("companyId")} workspaceId={workspaceId} emptyLabel="No company" />
            </Field>
            <Field label="Primary contact" className="sm:col-span-2">
              <RecordPicker type="contact" value={form.primaryContactId ?? null} onChange={set("primaryContactId")} workspaceId={workspaceId} emptyLabel="No contact" />
            </Field>
          </div>
        </>
      );

    case "project":
      return (
        <>
          <Field label="Project name" required>
            <Input autoFocus value={form.name ?? ""} onChange={(e) => set("name")(e.target.value)} />
          </Field>
          <Field label="What is this?">
            <Textarea rows={3} value={form.description ?? ""} onChange={(e) => set("description")(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client">
              <RecordPicker type="company" value={form.companyId ?? null} onChange={set("companyId")} workspaceId={workspaceId} emptyLabel="Internal" />
            </Field>
            <Field label="Status">
              <OptionSelect value={form.statusId ?? null} onValueChange={set("statusId")} options={statuses.map((s) => ({ value: s.id, label: s.name }))} placeholder="Default" />
            </Field>
            <Field label="Target date">
              <Input type="date" value={form.targetDate ?? ""} onChange={(e) => set("targetDate")(e.target.value)} />
            </Field>
            <Field label="Priority">
              <OptionSelect value={form.priority ?? "medium"} onValueChange={set("priority")} options={PROJECT_PRIORITY.options} />
            </Field>
          </div>
        </>
      );

    case "note":
      return (
        <>
          <Field label="Title">
            <Input autoFocus placeholder="Optional" value={form.title ?? ""} onChange={(e) => set("title")(e.target.value)} />
          </Field>
          <Field label="Note" required hint="Paste anything — Tiny AI can pull out the people, companies and next steps.">
            <Textarea rows={6} value={form.body ?? ""} onChange={(e) => set("body")(e.target.value)} />
          </Field>
          {linkFields}
        </>
      );

    case "opportunity":
      return (
        <>
          <Field label="Opportunity name" required>
            <Input autoFocus value={form.name ?? ""} onChange={(e) => set("name")(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Organization">
              <RecordPicker type="company" value={form.companyId ?? null} onChange={set("companyId")} workspaceId={workspaceId} emptyLabel="No organization" />
            </Field>
            <Field label="Solicitation #">
              <Input value={form.solicitationNumber ?? ""} onChange={(e) => set("solicitationNumber")(e.target.value)} />
            </Field>
            <Field label="Estimated value">
              <Input inputMode="decimal" value={form.estimatedValueCents ?? ""} onChange={(e) => set("estimatedValueCents")(e.target.value)} />
            </Field>
            <Field label="Proposal deadline">
              <Input type="date" value={form.proposalDeadlineAt ?? ""} onChange={(e) => set("proposalDeadlineAt")(e.target.value)} />
            </Field>
          </div>
        </>
      );

    case "meeting":
      return (
        <>
          <Field label="What happened?" required>
            <Input autoFocus placeholder="Call with…" value={form.title ?? ""} onChange={(e) => set("title")(e.target.value)} />
          </Field>
          <Field label="Notes">
            <Textarea rows={4} value={form.body ?? ""} onChange={(e) => set("body")(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <OptionSelect
                value={form.type ?? "meeting"}
                onValueChange={set("type")}
                options={[
                  { value: "meeting", label: "Meeting" },
                  { value: "call", label: "Call" },
                  { value: "email", label: "Email" },
                ]}
              />
            </Field>
            <Field label="Duration (min)">
              <Input inputMode="numeric" value={form.durationMin ?? ""} onChange={(e) => set("durationMin")(e.target.value)} />
            </Field>
          </div>
          {linkFields}
        </>
      );
  }
}

function labelFor(kind: QuickAddKind) {
  return KINDS.find((k) => k.kind === kind)?.label ?? "Record";
}

async function runCreate(
  kind: QuickAddKind,
  workspaceId: string,
  form: Record<string, string | null>,
  context: QuickAddContext,
): Promise<ActionResult<unknown> | null> {
  const s = (key: string) => form[key] ?? undefined;
  /**
   * Form values arrive as plain strings. Every action re-validates them with
   * Zod on the server, so this cast narrows for TypeScript only — an invalid
   * value still fails validation rather than reaching the database.
   */
  const asEnum = <T extends string>(key: string, fallback: T): T => (form[key] ?? fallback) as T;

  switch (kind) {
    case "task":
      return createTask({
        workspaceId, title: s("title") ?? "", dueAt: s("dueAt"), priority: asEnum("priority", "medium" as const),
        contactId: s("contactId"), companyId: s("companyId"), dealId: s("dealId"),
        projectId: s("projectId"), opportunityId: s("opportunityId"),
      });
    case "contact":
      return createContact({
        workspaceId, firstName: s("firstName") ?? "", lastName: s("lastName") ?? "",
        email: s("email"), jobTitle: s("jobTitle"), companyId: s("companyId"),
        relationshipType: asEnum("relationshipType", "prospect" as const),
      });
    case "company":
      return createCompany({
        workspaceId, name: s("name") ?? "", website: s("website"), industry: s("industry"),
      });
    case "deal": {
      const pipeline = context.pipelines.find((p) => p.workspaceId === workspaceId);
      const stageId = s("stageId") ?? pipeline?.stages[0]?.id;
      if (!pipeline || !stageId) {
        return { ok: false, error: "This workspace has no deal pipeline yet.", category: "validation" as const };
      }
      return createDeal({
        workspaceId, name: s("name") ?? "", pipelineId: pipeline.id, stageId,
        valueCents: s("valueCents"), expectedCloseAt: s("expectedCloseAt"),
        companyId: s("companyId"), primaryContactId: s("primaryContactId"),
      });
    }
    case "project":
      return createProject({
        workspaceId, name: s("name") ?? "", description: s("description"), companyId: s("companyId"),
        statusId: s("statusId"), targetDate: s("targetDate"), priority: asEnum("priority", "medium" as const),
      });
    case "note":
      return createNote({
        workspaceId, title: s("title"), body: s("body") ?? "",
        contactId: s("contactId"), companyId: s("companyId"), dealId: s("dealId"), projectId: s("projectId"),
      });
    case "opportunity":
      return createOpportunity({
        workspaceId, name: s("name") ?? "", companyId: s("companyId"),
        solicitationNumber: s("solicitationNumber"), estimatedValueCents: s("estimatedValueCents"),
        proposalDeadlineAt: s("proposalDeadlineAt"),
      });
    case "meeting":
      return logTimelineEntry({
        workspaceId, type: asEnum("type", "meeting" as const), title: s("title") ?? "", body: s("body"),
        durationMin: s("durationMin"), contactId: s("contactId"), companyId: s("companyId"),
        dealId: s("dealId"), projectId: s("projectId"),
      });
  }
}
