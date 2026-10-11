"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Gift, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  grantComplimentaryPlan, revokeComplimentaryPlan, suspendAccount, reinstateAccount,
} from "@/lib/actions/admin";

/**
 * The controls that change something, each behind its own confirmation.
 *
 * Every one states what it does **not** do, in the dialog rather than in
 * documentation nobody opens: a grant creates no subscription and charges
 * nothing; a suspension cancels nothing and refunds nothing. Those are the two
 * things an operator is most likely to assume wrongly, and the moment to say
 * so is while they are deciding.
 *
 * A reason is required by the server, not merely by the form — these submit to
 * actions that validate independently, because a dialog is an affordance and
 * the action is the control.
 */

type Grant = { plan: string; reason: string; expiresAt: Date | null } | null;

export function CustomerControls({
  userId,
  email,
  suspended,
  suspendedReason,
  grant,
  isSelf,
}: {
  userId: string;
  email: string;
  suspended: boolean;
  suspendedReason: string | null;
  grant: Grant;
  isSelf: boolean;
}) {
  const [open, setOpen] = React.useState<null | "grant" | "revoke" | "suspend" | "reinstate">(null);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen("grant")}>
          <Gift className="size-3.5" aria-hidden />
          {grant ? "Change complimentary access" : "Grant complimentary access"}
        </Button>
        {grant ? (
          <Button variant="outline" size="sm" onClick={() => setOpen("revoke")}>
            Revoke complimentary access
          </Button>
        ) : null}
        {suspended ? (
          <Button variant="outline" size="sm" onClick={() => setOpen("reinstate")}>
            <ShieldCheck className="size-3.5" aria-hidden /> Reinstate
          </Button>
        ) : (
          <Button
            variant="danger"
            size="sm"
            disabled={isSelf}
            title={isSelf ? "You cannot suspend your own account." : undefined}
            onClick={() => setOpen("suspend")}
          >
            <ShieldAlert className="size-3.5" aria-hidden /> Suspend
          </Button>
        )}
      </div>

      {isSelf ? (
        <p className="mt-2 text-[12px] text-faint">
          This is your own account. Suspension is refused by the server as well as hidden here.
        </p>
      ) : null}

      <GrantDialog
        open={open === "grant"}
        onOpenChange={(v) => setOpen(v ? "grant" : null)}
        userId={userId}
        email={email}
        existing={grant}
      />
      <ReasonDialog
        open={open === "revoke"}
        onOpenChange={(v) => setOpen(v ? "revoke" : null)}
        title="Revoke complimentary access"
        description={
          `${email} will fall back to whatever their own plan entitles them to. ` +
          `Nothing is cancelled at Stripe and no refund is issued — this only ends the grant.`
        }
        confirmLabel="Revoke access"
        onSubmit={(reason) => revokeComplimentaryPlan({ userId, reason })}
      />
      <ReasonDialog
        open={open === "suspend"}
        onOpenChange={(v) => setOpen(v ? "suspend" : null)}
        title="Suspend this account"
        destructive
        description={
          `${email} will be signed out immediately and cannot sign in again until reinstated. ` +
          `This does not cancel their Stripe subscription and does not issue a refund — ` +
          `if they are paying, they keep paying. Cancel or refund in Stripe separately.`
        }
        confirmLabel="Suspend account"
        onSubmit={(reason) => suspendAccount({ userId, reason })}
      />
      <ReasonDialog
        open={open === "reinstate"}
        onOpenChange={(v) => setOpen(v ? "reinstate" : null)}
        title="Reinstate this account"
        description={
          `${email} will be able to sign in again.` +
          (suspendedReason ? ` They were suspended for: ${suspendedReason}` : "")
        }
        confirmLabel="Reinstate account"
        onSubmit={(reason) => reinstateAccount({ userId, reason })}
      />
    </>
  );
}

/** Grant or change complimentary access. */
function GrantDialog({
  open, onOpenChange, userId, email, existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  email: string;
  existing: Grant;
}) {
  const router = useRouter();
  const [plan, setPlan] = React.useState<"plus" | "pro">("pro");
  const [reason, setReason] = React.useState("");
  const [expiresOn, setExpiresOn] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    try {
      const result = await grantComplimentaryPlan({ userId, plan, reason, expiresOn });
      if (result.ok) {
        toast.success(`Complimentary ${plan} granted to ${email}`);
        onOpenChange(false);
        setReason("");
        setExpiresOn("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Change complimentary access" : "Grant complimentary access"}</DialogTitle>
          <DialogDescription>
            This creates <strong>no Stripe subscription</strong> and charges nothing. It sits
            alongside whatever {email} already pays for, and only ever adds — a grant can never
            reduce what an account can do.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Plan">
            <select
              aria-label="Complimentary plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value as "plus" | "pro")}
              className="h-9 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-[13px] text-body"
            >
              <option value="plus">Plus</option>
              <option value="pro">Pro</option>
            </select>
          </Field>
          <Field label="Reason" hint="Recorded in the audit trail. Required.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Design partner for Q1"
              aria-label="Reason for the grant"
            />
          </Field>
          <Field label="Expires on" hint="Optional. Leave empty for open-ended access.">
            <Input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              aria-label="Expiry date"
            />
          </Field>
          {existing ? (
            <p className="text-[12px] text-muted">
              The current {existing.plan} grant will be revoked and replaced, so the reason it was
              originally given stays in the record.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || reason.trim().length < 3}>
            {busy ? "Saving…" : existing ? "Replace grant" : "Grant access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A confirmation that requires a stated reason. */
function ReasonDialog({
  open, onOpenChange, title, description, confirmLabel, destructive, onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onSubmit: (reason: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    try {
      const result = await onSubmit(reason);
      if (result.ok) {
        toast.success(title.replace(/^./, (c) => c.toUpperCase()) + " — done");
        onOpenChange(false);
        setReason("");
        router.refresh();
      } else {
        toast.error(result.error ?? "That did not work.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive ? <AlertTriangle className="size-4 text-rose-500" aria-hidden /> : null}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Reason" hint="Recorded in the audit trail. Required.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Reason"
              placeholder="Why this is happening"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            variant={destructive ? "danger" : "default"}
            onClick={submit}
            disabled={busy || reason.trim().length < 3}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
