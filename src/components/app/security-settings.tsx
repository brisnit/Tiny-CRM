"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle, Check, Copy, KeyRound, Laptop, LogOut, Mail, ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelHeader } from "@/components/ui/surface";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  beginMfaEnrolment, confirmMfaEnrolment, disableMfa, regenerateRecoveryCodes,
  requestEmailVerification, signOutOtherSessions, signOutSession,
} from "@/lib/actions/account";
import { cn } from "@/lib/utils";

/**
 * Security → the screen that makes the new controls usable.
 *
 * Session revocation, email verification and second factors all existed as
 * server capabilities before this; without a screen, none of them was reachable
 * by the person they protect. A control nobody can find is not a control.
 *
 * Two deliberate presentation choices:
 *
 *  - **Sessions show a truncated network, never a full address.** Enough for
 *    "that is not me", not enough to be a movement log of the user.
 *  - **Two-factor says plainly that it is not yet demanded at sign-in.** A user
 *    who enrols and believes they are protected, but is not, is in a worse
 *    position than one who knows. The badge says "enrolment only" until the
 *    sign-in challenge ships.
 */

export type SessionRow = {
  id: string;
  device: string;
  location: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

export type MfaState = {
  enrolled: boolean;
  confirmed: boolean;
  recoveryCodesRemaining: number;
  enforcedAtSignIn: boolean;
};

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------

export function EmailVerification({
  email,
  verifiedAt,
  mailConfigured,
}: {
  email: string;
  verifiedAt: string | null;
  mailConfigured: boolean;
}) {
  const [pending, startTransition] = React.useTransition();

  if (verifiedAt) {
    return (
      <Panel>
        <PanelHeader title="Email address" description="Confirmed — no action needed" />
        <div className="flex items-center gap-3 border-t border-hairline p-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
            <Check className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-body">{email}</p>
            <p className="text-[12px] text-muted">Confirmed {relative(verifiedAt)}</p>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Confirm your email address"
        description="Until you do, some things are held back"
      />
      <div className="space-y-3 border-t border-hairline p-4">
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <div>
            <p className="font-medium">{email} has not been confirmed.</p>
            <p className="mt-1">
              You can use your workspaces normally. Until this is confirmed you cannot invite
              people, export data, run an import, or connect an integration — each of those
              reaches past you, and an unconfirmed address might not be yours.
            </p>
          </div>
        </div>

        {mailConfigured ? (
          <Button
            variant="brand"
            size="sm"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await requestEmailVerification();
                if (!result.ok) toast.error(result.error);
                else if (result.data.sent) toast.success("Check your inbox for a confirmation link.");
                else toast.error("Could not send the email. Check the mail provider configuration.");
              })
            }
          >
            <Mail className="size-3.5" />
            Send a confirmation link
          </Button>
        ) : (
          <p className="text-[12px] text-muted">
            No mail provider is configured on this deployment, so confirmation links cannot be
            sent — and the restrictions above are not being enforced.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function ActiveSessions({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const others = sessions.filter((s) => !s.current).length;

  return (
    <Panel>
      <PanelHeader
        title="Active sessions"
        description="Where you are signed in. Sign out anything you do not recognise."
        action={
          others > 0 ? (
            <Button
              variant="outline"
              size="xs"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await signOutOtherSessions();
                  if (result.ok) {
                    toast.success(
                      `Signed out ${result.data.revoked} other session${result.data.revoked === 1 ? "" : "s"}`,
                    );
                    router.refresh();
                  } else toast.error(result.error);
                })
              }
            >
              <LogOut className="size-3" />
              Sign out others
            </Button>
          ) : undefined
        }
      />

      <ul className="divide-y divide-hairline border-t border-hairline">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3 px-4 py-3">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full",
                session.current
                  ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400"
                  : "bg-sunken text-faint",
              )}
            >
              <Laptop className="size-4" />
            </span>

            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] font-medium text-body">
                {session.device}
                {session.current ? <Badge>This device</Badge> : null}
              </p>
              <p className="text-[12px] text-muted">
                Last active {relative(session.lastSeenAt)}
                {/* A truncated network, never a full address — enough to
                    recognise "not me", not enough to place someone. */}
                {session.location ? ` · from ${session.location}` : ""}
              </p>
            </div>

            {session.current ? null : (
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  startTransition(async () => {
                    const result = await signOutSession(session.id);
                    if (result.ok) {
                      toast.success("Signed out");
                      router.refresh();
                    } else toast.error(result.error);
                  })
                }
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>

      <p className="border-t border-hairline px-4 py-2.5 text-[11.5px] text-faint">
        Changing your password signs out every session, including this one.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function TwoFactor({ state }: { state: MfaState }) {
  const router = useRouter();
  const [enrolling, setEnrolling] = React.useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [code, setCode] = React.useState("");
  const [disabling, setDisabling] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <Panel>
        <PanelHeader
          title="Two-factor authentication"
          description="An authenticator app code, in addition to your password"
        />

        <div className="space-y-3 border-t border-hairline p-4">
          {/*
            Stated first and plainly. Everything below works — enrolment,
            verification, recovery codes — but sign-in does not yet demand a
            code, and a user who believes otherwise is worse off than one who
            knows.
          */}
          {!state.enforcedAtSignIn ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <div>
                <p className="font-medium">Enrolment only, for now.</p>
                <p className="mt-1">
                  You can set up an authenticator and keep recovery codes, but sign-in does not
                  yet ask for a code. Treat this as preparation, not as protection.
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full",
                state.confirmed
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                  : "bg-sunken text-faint",
              )}
            >
              <ShieldCheck className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-body">
                {state.confirmed ? "Set up" : "Not set up"}
              </p>
              {state.confirmed ? (
                <p className="text-[12px] text-muted">
                  {state.recoveryCodesRemaining} recovery code
                  {state.recoveryCodesRemaining === 1 ? "" : "s"} left
                </p>
              ) : null}
            </div>

            {state.confirmed ? (
              <div className="flex gap-1.5">
                <Button variant="outline" size="xs" onClick={() => { setCode(""); setCodes(null); setDisabling(false); setEnrolling(null); regenerate(); }}>
                  New recovery codes
                </Button>
                <Button variant="ghost" size="xs" className="text-rose-600 hover:text-rose-700 dark:text-rose-400" onClick={() => { setCode(""); setPassword(""); setDisabling(true); }}>
                  Turn off
                </Button>
              </div>
            ) : (
              <Button
                variant="brand"
                size="sm"
                loading={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await beginMfaEnrolment();
                    if (result.ok) setEnrolling(result.data);
                    else toast.error(result.error);
                  })
                }
              >
                <KeyRound className="size-3.5" />
                Set up
              </Button>
            )}
          </div>
        </div>
      </Panel>

      {/* --- Enrolment ---------------------------------------------------- */}
      <Dialog open={Boolean(enrolling)} onOpenChange={(open) => !open && setEnrolling(null)}>
        <DialogContent width="md">
          <DialogHeader>
            <DialogTitle>Set up two-factor authentication</DialogTitle>
            <DialogDescription>
              Add this to your authenticator app, then type the code it shows.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Setup key" htmlFor="mfa-secret">
              <div className="flex gap-2">
                <Input id="mfa-secret" readOnly value={enrolling?.secret ?? ""} className="font-mono text-[12px]" />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy setup key"
                  onClick={() => {
                    void navigator.clipboard.writeText(enrolling?.secret ?? "");
                    toast.success("Copied");
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </Field>

            <Field label="Code from your app" htmlFor="mfa-code" hint="Six digits.">
              <Input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
                className="font-mono tracking-[0.3em]"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEnrolling(null)}>Cancel</Button>
            <Button
              variant="brand"
              loading={pending}
              disabled={code.trim().length !== 6}
              onClick={() =>
                startTransition(async () => {
                  const result = await confirmMfaEnrolment(code);
                  if (result.ok) {
                    setEnrolling(null);
                    setCodes(result.data.recoveryCodes);
                    router.refresh();
                  } else toast.error(result.error);
                })
              }
            >
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Recovery codes, shown exactly once ---------------------------- */}
      <Dialog open={Boolean(codes)} onOpenChange={(open) => !open && setCodes(null)}>
        <DialogContent width="md">
          <DialogHeader>
            <DialogTitle>Save your recovery codes</DialogTitle>
            <DialogDescription>
              Each works once, if you lose your authenticator. Only their hashes are stored —
              this is the only time they can be shown.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="grid grid-cols-2 gap-1.5 rounded-lg border border-hairline bg-sunken/60 p-3 font-mono text-[12.5px] text-body">
              {(codes ?? []).map((value) => <li key={value}>{value}</li>)}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText((codes ?? []).join("\n"));
                toast.success("Copied");
              }}
            >
              <Copy className="size-3.5" />
              Copy all
            </Button>
            <Button variant="brand" onClick={() => setCodes(null)}>I have saved them</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Turning it off ------------------------------------------------ */}
      <Dialog open={disabling} onOpenChange={setDisabling}>
        <DialogContent width="sm">
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication?</DialogTitle>
            <DialogDescription>
              Your password and a current code, both — a stolen session alone must not be able to
              remove the control that a stolen session is meant to be stopped by.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Field label="Current password" htmlFor="mfa-password">
              <Input
                id="mfa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="Code, or a recovery code" htmlFor="mfa-off-code">
              <Input
                id="mfa-off-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="font-mono"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisabling(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={!password || !code}
              onClick={() =>
                startTransition(async () => {
                  const result = await disableMfa({ password, code });
                  if (result.ok) {
                    toast.success("Two-factor authentication turned off");
                    setDisabling(false);
                    router.refresh();
                  } else toast.error(result.error);
                })
              }
            >
              Turn off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  function regenerate() {
    const entered = window.prompt("Enter a current code from your authenticator");
    if (!entered) return;
    startTransition(async () => {
      const result = await regenerateRecoveryCodes(entered);
      if (result.ok) {
        setCodes(result.data.recoveryCodes);
        router.refresh();
      } else toast.error(result.error);
    });
  }
}
