"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { deleteContact } from "@/lib/actions/contacts";
import { deleteCompany } from "@/lib/actions/companies";
import { deleteDeal } from "@/lib/actions/deals";
import { deleteProject } from "@/lib/actions/projects";
import { deleteOpportunity } from "@/lib/actions/opportunities";

type EntityType = "contact" | "company" | "deal" | "project" | "opportunity";

const DELETERS: Record<EntityType, (id: string) => Promise<{ ok: boolean; error?: string }>> = {
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
}: {
  entityType: EntityType;
  id: string;
  name: string;
  onEdit?: () => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function remove() {
    startTransition(async () => {
      const result = await DELETERS[entityType](id);
      if (result.ok) {
        toast.success(`${name} deleted`);
        router.push(LIST_PATH[entityType] as never);
        router.refresh();
      } else {
        toast.error(result.error ?? "Could not delete that.");
        setConfirming(false);
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
        <DropdownMenuContent align="end" className="w-48">
          {onEdit ? (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => setConfirming(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent width="sm">
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              This also removes its tasks, notes and timeline. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="py-0" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={pending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
