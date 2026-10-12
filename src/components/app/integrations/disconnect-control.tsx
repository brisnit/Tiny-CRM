"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { disconnectIntegration } from "@/lib/actions/integrations";

/**
 * Disconnecting, behind a confirmation that asks the one question that matters.
 *
 * Imported mail is the only thing here a customer can lose, so the dialog puts
 * the choice in front of them rather than applying a default and mentioning it
 * afterwards. Keeping is pre-selected: correspondence filed against a deal
 * should survive a mailbox being disconnected, and the destructive option has
 * to be chosen deliberately.
 *
 * The dialog is an affordance, not the control — the action validates and
 * authorises independently, and finds the connection from the session rather
 * than from anything this component sends.
 */
export function DisconnectControl({ provider, label }: { provider: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [keepImported, setKeepImported] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    const result = await disconnectIntegration({ provider, keepImported });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const removed = result.data.removedEmails + result.data.removedEvents;
    toast.success(
      keepImported
        ? `${label} disconnected. Everything already imported is still here.`
        : `${label} disconnected and ${removed} imported ${removed === 1 ? "record" : "records"} removed.`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {label}?</DialogTitle>
            <DialogDescription>
              Tiny will immediately forget its access and stop any import that is queued or already
              running. Nothing changes in your mailbox or calendar.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-[12.5px] font-semibold text-body">
                What should happen to what has already been imported?
              </legend>
              <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-relaxed text-muted">
                <input
                  type="radio"
                  name="keep"
                  className="mt-0.5"
                  checked={keepImported}
                  onChange={() => setKeepImported(true)}
                />
                <span>
                  <strong className="font-semibold text-body">Keep it.</strong> Messages and meetings
                  already imported stay, including any you have attached to a contact or deal. They
                  will no longer be updated.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-relaxed text-muted">
                <input
                  type="radio"
                  name="keep"
                  className="mt-0.5"
                  checked={!keepImported}
                  onChange={() => setKeepImported(false)}
                />
                <span>
                  <strong className="font-semibold text-body">Remove it.</strong> Deletes everything
                  this connection imported. This cannot be undone, and anything you attached to a
                  contact or deal goes with it.
                </span>
              </label>
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? "Disconnecting…" : keepImported ? "Disconnect" : "Disconnect and remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
