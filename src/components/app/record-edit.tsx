"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QuickAddFields, type QuickAddContext } from "@/components/app/quick-add";
import { RecordActions } from "@/components/app/record-actions";
import { updateContact } from "@/lib/actions/contacts";
import { updateCompany } from "@/lib/actions/companies";
import { updateDeal } from "@/lib/actions/deals";
import { updateProject } from "@/lib/actions/projects";
import { updateOpportunity } from "@/lib/actions/opportunities";
import {
  COMPANY_SIZE, COMPANY_TYPE, LEAD_SOURCE, PROJECT_TYPE, REVENUE_RANGE,
} from "@/lib/enums";
import type { ActionResult } from "@/lib/actions/base";

/** The value union behind one of the enum maps in lib/enums. */
type EnumValue<M extends { values: readonly string[] }> = M["values"][number];

export type EditableKind = "contact" | "company" | "deal" | "project" | "opportunity";

/**
 * Editing a record, using the same fields that created it.
 *
 * Every one of these `update*` actions already existed, with authorization,
 * validation, relation checks and audit — none of it reachable. The record
 * pages offered Archive and Delete permanently and nothing else, so correcting
 * a mistyped deal value meant deleting the deal and starting again. That is
 * what an audit against the deployed application found, and it is the single
 * change that most affects whether a real customer can use this.
 *
 * The fields come from QuickAddFields rather than a second form. Two forms for
 * the same record drift: the create dialog grows a field, the edit dialog
 * silently cannot change it, and the difference is invisible until a customer
 * needs it.
 *
 * Optimistic concurrency is preserved. Each update carries the `version` it was
 * loaded with, so two people editing the same record cannot silently overwrite
 * one another — the second save is refused rather than winning.
 */
export function RecordEditDialog({
  open,
  onOpenChange,
  kind,
  id,
  version,
  initial,
  context,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: EditableKind;
  id: string;
  version: number;
  initial: Record<string, string | null>;
  context: QuickAddContext;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<Record<string, string | null>>(initial);

  // Remounted per opening by the caller, so the form always starts from the
  // record as it is now rather than as it was when the page first rendered.
  const set = (key: string) => (value: string | null) => setForm((f) => ({ ...f, [key]: value }));

  const workspaceId = context.defaultWorkspaceId ?? context.workspaces[0]?.id ?? "";
  const pipeline = context.pipelines.find((p) => p.workspaceId === workspaceId);

  function save() {
    startTransition(async () => {
      const result = await runUpdate(kind, id, version, form);
      if (result.ok) {
        toast.success("Saved");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" className="p-0">
        <DialogHeader>
          <DialogTitle>Edit {LABEL[kind]}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <QuickAddFields
            kind={kind}
            form={form}
            set={set}
            workspaceId={workspaceId}
            dealPipeline={pipeline}
            statuses={context.statuses.filter((s) => s.workspaceId === workspaceId)}
            members={context.members.filter((m) => m.workspaceId === workspaceId)}
            // Editing shows every field. Quick add folds the extras away to stay
            // quick; a record page is where someone fills in the rest.
            expanded
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The record header's actions, with Edit wired in.
 *
 * A server component cannot hand `RecordActions` an `onEdit` callback, which is
 * why the prop existed and was never passed. This owns the dialog state on the
 * client so the pages stay server components.
 */
export function RecordHeaderActions(props: {
  kind: EditableKind;
  id: string;
  name: string;
  version: number;
  initial: Record<string, string | null>;
  context: QuickAddContext;
  canDelete?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <RecordActions
        entityType={props.kind}
        id={props.id}
        name={props.name}
        canDelete={props.canDelete}
        onEdit={() => setOpen(true)}
      />
      {open ? (
        <RecordEditDialog
          open={open}
          onOpenChange={setOpen}
          kind={props.kind}
          id={props.id}
          version={props.version}
          initial={props.initial}
          context={props.context}
        />
      ) : null}
    </>
  );
}

const LABEL: Record<EditableKind, string> = {
  contact: "contact",
  company: "company",
  deal: "deal",
  project: "project",
  opportunity: "opportunity",
};

async function runUpdate(
  kind: EditableKind,
  id: string,
  version: number,
  form: Record<string, string | null>,
): Promise<ActionResult<unknown>> {
  // Values arrive as strings from the form. Every action re-validates with Zod
  // on the server, so this only narrows for TypeScript.
  const s = (key: string) => form[key] ?? undefined;
  const asEnum = <T extends string>(key: string, fallback: T): T => (form[key] ?? fallback) as T;
  // An optional enum the person can clear. "" means "no value" and has to reach
  // the server as null, not as the empty string, which no enum accepts.
  const nullableEnum = <T extends string>(key: string): T | null =>
    form[key] ? (form[key] as T) : null;

  switch (kind) {
    case "contact":
      return updateContact(id, {
        version, firstName: s("firstName"), lastName: s("lastName"), email: s("email"),
        phone: s("phone"), jobTitle: s("jobTitle"), companyId: s("companyId") ?? null,
        relationshipType: asEnum("relationshipType", "prospect" as const),
        location: s("location"), linkedin: s("linkedin"), website: s("website"),
        leadSource: nullableEnum<EnumValue<typeof LEAD_SOURCE>>("leadSource"),
        ownerId: s("ownerId") ?? null, description: s("description"),
        lastContactedAt: s("lastContactedAt"), nextFollowUpAt: s("nextFollowUpAt"),
      });
    case "company":
      return updateCompany(id, {
        version, name: s("name"), website: s("website"), industry: s("industry"),
        domain: s("domain"), location: s("location"),
        size: nullableEnum<EnumValue<typeof COMPANY_SIZE>>("size"),
        revenueRange: nullableEnum<EnumValue<typeof REVENUE_RANGE>>("revenueRange"),
        type: nullableEnum<EnumValue<typeof COMPANY_TYPE>>("type"),
        leadSource: nullableEnum<EnumValue<typeof LEAD_SOURCE>>("leadSource"),
        relationshipStatus: asEnum("relationshipStatus", "prospect" as const),
        primaryContactId: s("primaryContactId") ?? null,
        ownerId: s("ownerId") ?? null, description: s("description"),
      });
    case "deal":
      return updateDeal(id, {
        version, name: s("name"), valueCents: s("valueCents"),
        expectedCloseAt: s("expectedCloseAt"), stageId: s("stageId"),
        companyId: s("companyId") ?? null, primaryContactId: s("primaryContactId") ?? null,
        projectId: s("projectId") ?? null,
      });
    case "project":
      return updateProject(id, {
        version, name: s("name"), description: s("description"),
        companyId: s("companyId") ?? null, statusId: s("statusId"),
        targetDate: s("targetDate"), priority: asEnum("priority", "medium" as const),
        startDate: s("startDate"), type: nullableEnum<EnumValue<typeof PROJECT_TYPE>>("type"),
        budgetCents: s("budgetCents"), revenueCents: s("revenueCents"),
        nextAction: s("nextAction"), nextActionDueAt: s("nextActionDueAt"),
        ownerId: s("ownerId") ?? null,
      });
    case "opportunity":
      return updateOpportunity(id, {
        version, name: s("name"), companyId: s("companyId") ?? null,
        solicitationNumber: s("solicitationNumber"),
        estimatedValueCents: s("estimatedValueCents"),
        proposalDeadlineAt: s("proposalDeadlineAt"),
        projectId: s("projectId") ?? null,
      });
  }
}
