import Link from "next/link";

import { InviteAccept } from "@/components/app/invite-accept";
import { SignupForm } from "@/components/app/auth-forms";
import { Badge } from "@/components/ui/badge";
import { getIdentity } from "@/lib/auth/context";
import { lookupInvitation, normaliseEmail } from "@/lib/auth/invitations";
import { WORKSPACE_ROLE } from "@/lib/enums";

export const metadata = { title: "Join a workspace" };

/**
 * The one page an invited person lands on.
 *
 * Public, deliberately: the recipient may have no account yet, and requiring
 * one before showing what they were invited to would be asking them to sign up
 * for something they cannot see.
 *
 * Three things it must get right:
 *
 *  - **Every failure looks the same.** Expired, revoked, already used and never
 *    existed all render one panel with one sentence. The distinction matters to
 *    the person who was invited and is a disclosure to anyone else — and an
 *    unauthenticated stranger holding a guessed token is exactly "anyone else".
 *  - **It never creates a workspace.** Nothing on this path touches
 *    provisioning. Signing up from here returns here, and acceptance adds the
 *    membership before any guard can ask whether this account has one.
 *  - **The address is fixed.** An invitation is bound to one email, so the
 *    sign-up form is pre-filled and read-only. Letting it be edited would only
 *    produce an account that cannot redeem the link it came from.
 */
export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const [identity, found] = await Promise.all([getIdentity(), lookupInvitation(token)]);

  if (!found.ok) return <Invalid />;

  const invitation = found.invitation;
  const roleLabel = WORKSPACE_ROLE.label(invitation.role, invitation.role);
  const inviter = invitation.invitedByName?.trim() || "Someone";
  const next = `/invite/${encodeURIComponent(token)}`;

  const header = (
    <div className="mb-5 text-center">
      <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">
        Join {invitation.workspaceName}
      </h1>
      <p className="mt-1.5 text-[13px] text-muted">
        {inviter} invited <span className="text-body">{invitation.email}</span> to work in this
        workspace on Tiny CRM.
      </p>
      <div className="mt-3 flex items-center justify-center gap-2">
        <span className="text-[12px] text-faint">Role</span>
        <Badge tone={WORKSPACE_ROLE.tone(invitation.role)}>{roleLabel}</Badge>
      </div>
    </div>
  );

  // Signed in as somebody else. Say so plainly rather than silently failing on
  // the next click — the fix is theirs to make, and it is a one-line one.
  if (identity && normaliseEmail(identity.email) !== normaliseEmail(invitation.email)) {
    return (
      <Panel>
        {header}
        <p className="rounded-lg bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          You are signed in as <span className="font-medium">{identity.email}</span>, and this
          invitation was sent to <span className="font-medium">{invitation.email}</span>. Sign in
          with that address to accept it.
        </p>
        <p className="mt-4 text-center text-[13px] text-muted">
          <Link
            href="/api/auth/signout"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Sign out
          </Link>
        </p>
      </Panel>
    );
  }

  if (identity) {
    return (
      <Panel>
        {header}
        <InviteAccept token={token} workspaceName={invitation.workspaceName} />
      </Panel>
    );
  }

  return (
    <Panel>
      {header}
      <div className="rounded-lg border border-hairline bg-canvas px-4 py-3.5">
        <h2 className="text-[13.5px] font-semibold text-body">Create your account</h2>
        <p className="mt-0.5 mb-3 text-[12.5px] text-muted">
          You will join {invitation.workspaceName} straight away — no separate workspace is
          created.
        </p>
        <SignupForm plan="free" next={next} fixedEmail={invitation.email} />
      </div>

      {/*
        A link rather than a second form. Rendering the sign-in form here too
        put two elements with id="email" on one page, which breaks every label
        association on it — and it asked the visitor to pick a lane before
        reading what they were offered.
      */}
      <p className="mt-5 text-center text-[13px] text-muted">
        Already use Tiny?{" "}
        <Link
          href={{ pathname: "/login", query: { next } }}
          className="font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Sign in to accept
        </Link>
      </p>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-hairline bg-panel p-6 shadow-panel">{children}</div>
  );
}

/**
 * One state for every failure.
 *
 * Expired, revoked, spent and never-existed are four different facts and one
 * message. Distinguishing them here would confirm to anyone holding a string
 * that it once named a real invitation.
 */
function Invalid() {
  return (
    <Panel>
      <div className="text-center">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-body">
          This invitation is no longer valid
        </h1>
        <p className="mt-1.5 text-[13px] text-muted">
          Invitation links expire, and can only be used once. Ask whoever invited you to send
          another one.
        </p>
        <p className="mt-5 text-[13px] text-muted">
          <Link
            href="/login"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Sign in to Tiny CRM
          </Link>
        </p>
      </div>
    </Panel>
  );
}
