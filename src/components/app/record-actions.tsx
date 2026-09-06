"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Archive, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { archiveContact, deleteContact } from "@/lib/actions/contacts";
import { archiveCompany, deleteCompany } from "@/lib/actions/companies";
import { archiveDeal, deleteDeal } from "@/lib/actions/deals";
import { archiveProject, deleteProject } from "@/lib/actions/projects";
import { archiveOpportunity, deleteOpportunity } from "@/lib/actions/opportunities";

type EntityType = "contact" | "company" | "deal" | "project" | "opportunity";

type ActionResponse = { ok: boolean; error?: string };

/**
 * Record-level destructive actions.
 *
 * Two tiers, deliberately different in weight:
 *
 *  - **Archive** is one click and reversible. It is what "delete" means in the
 *    UI for anything that carries history.
 *  - **Delete permanently** requires retyping the record's name. The typed
 *    confirmation is re-verified on the server (`assertConfirmation`), because a
 *    dialog is a convenience and not a control — a direct call to the action
 *    would skip it entirely.
 */
const ARCHIVERS: Record<EntityType, (id: string) => Promise<ActionResponse>> = {
  contact: archiveContact,
  company: archiveCompany,
  deal: archiveDeal,
  project: archiveProject,
  opportunity: archiveOpportunity,
};

const DELETERS: Record<EntityType, (id: string, confirmation: string) => Promise<ActionResponse>> = {
  contact: deleteContact,
  company: deleteCompany,
  deal: deleteDeal,
  project: deleteProject,
  opportunity: deleteOpportunity,
};

const LIST_PATH: Record<EntityType, string> = {
  contact: "/contacts",
  company: "/companies",
  deal: "/deals",
  project: "/projects",
  opportunity: "/opportunities",
};

export function RecordActions({
  entityType,
  id,
  name,
  onEdit,
  canDelete = true,
}: {
  entityType: EntityType;
  id: string;
  name: string;
  onEdit?: () => void;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const matches = confirmation.trim().toLowerCase() === name.trim().toLowerCase();

  function archive() {
    startTransition(async () => {
      const result = await ARCHIVERS[entityType](id);
      if (result.ok) {
        toast.success(`${name} archived`, { description: "You can restore it from the archive." });
        router.push(LIST_PATH[entityType] as never);
        router.refresh();
      } else {
        toast.error(result.error ?? "Could not archive that.");
      }
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await DELETERS[entityType](id, confirmation);
      if (result.ok) {
        toast.success(`${name} permanently deleted`);
        router.push(LIST_PATH[entityType] as never);
        router.refresh();
      } else {
        toast.error(result.error ?? "Could not delete that.");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label="More actions">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {onEdit ? (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={archive}>
            <Archive />
            Archive
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                danger
                onSelect={() => {
                  setConfirmation("");
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 />
                Delete permanently
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent width="md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-rose-500" />
              Permanently delete {name}?
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. Archiving keeps the record and its history and can be reversed.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Everything attached to this record — tasks, notes, timeline activity and files — is
              kept and detached rather than deleted, so the history of what happened is not lost.
            </div>

            <Field
              label={
                <span>
                  Type <span className="font-mono font-semibold">{name}</span> to confirm
                </span>
              }
              htmlFor="delete-confirmation"
            >
              <Input
                id="delete-confirmation"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
                placeholder={name}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button variant="subtle" onClick={archive} disabled={pending}>
              <Archive className="size-3.5" />
              Archive instead
            </Button>
            <Button variant="danger" onClick={remove} loading={pending} disabled={!matches}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
