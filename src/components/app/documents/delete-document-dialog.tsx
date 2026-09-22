"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { deleteFile } from "@/lib/actions/files";

/**
 * Confirming a document deletion.
 *
 * The same shape as every other permanent delete in the product: type the name
 * to confirm, and the server checks it again with `assertConfirmation`. The
 * typing is an affordance; the server is the control, because a direct call to
 * the action would skip any amount of dialog.
 *
 * It is worth the friction here for a reason that does not apply to a contact:
 * there is no Trash for a document. Deleting one removes the row *and* the
 * stored object, so there is nothing to restore from.
 */
export function DeleteDocumentDialog({
  open,
  onOpenChange,
  fileId,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId: string;
  name: string;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const matches = confirmation.trim().toLowerCase() === name.trim().toLowerCase();

  // No effect resets this between deletions: the panel renders this component
  // only while a document is selected, so each deletion mounts a fresh one and
  // the field starts empty on its own.

  function remove() {
    startTransition(async () => {
      const result = await deleteFile(fileId, confirmation);
      if (result.ok) {
        toast.success(`${name} deleted`);
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-rose-500" />
            Delete this document?
          </DialogTitle>
          <DialogDescription>
            {name} will be removed from this project and deleted from storage. There is no
            Trash for documents, so this cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-2">
          <Field
            label={
              <span>
                Type <span className="font-mono font-semibold">{name}</span> to confirm
              </span>
            }
            htmlFor="delete-document-confirmation"
          >
            <Input
              id="delete-document-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              placeholder={name}
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={remove} loading={pending} disabled={!matches}>
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
