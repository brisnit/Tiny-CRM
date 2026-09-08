"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/label";
import { RecordPicker } from "@/components/app/record-picker";
import { setProjectContact } from "@/lib/actions/projects";

/**
 * Attaching a person to a project.
 *
 * The People panel told everyone to "add the client contacts and collaborators
 * on this project" and offered nothing to add them with. `ProjectContact` was
 * in the schema from the beginning and no code ever wrote to it, so the panel
 * on every project was permanently empty — and "who is involved" is one of the
 * questions Project Intelligence exists to answer.
 */
export function AddProjectPerson({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [contactId, setContactId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function add() {
    if (!contactId) {
      toast.error("Choose a person first.");
      return;
    }
    startTransition(async () => {
      const result = await setProjectContact(projectId, contactId, true);
      if (result.ok) {
        toast.success("Added to the project");
        setOpen(false);
        setContactId(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Add person
      </Button>

      {open ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent width="sm">
            <DialogHeader>
              <DialogTitle>Add someone to this project</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <Field label="Person">
                <RecordPicker
                  type="contact"
                  value={contactId}
                  onChange={setContactId}
                  workspaceId={workspaceId}
                  emptyLabel="Choose a contact"
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={add} disabled={pending || !contactId}>
                {pending ? "Adding…" : "Add to project"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/** Removing someone, so an accidental link is not permanent. */
export function RemoveProjectPerson({
  projectId,
  contactId,
  name,
}: {
  projectId: string;
  contactId: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label={`Remove ${name} from this project`}
      onClick={() =>
        startTransition(async () => {
          const result = await setProjectContact(projectId, contactId, false);
          if (result.ok) {
            toast.success(`${name} removed from the project`);
            router.refresh();
          } else {
            toast.error(result.error);
          }
        })
      }
    >
      Remove
    </Button>
  );
}
