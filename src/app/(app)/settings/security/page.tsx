import { db } from "@/lib/db";
import { requireActor } from "@/lib/auth/access";
import { listSessions } from "@/lib/auth/sessions";
import { mfaStatus } from "@/lib/auth/mfa";
import { mailConfigured } from "@/lib/mail";
import {
  ActiveSessions, EmailVerification, TwoFactor,
} from "@/components/app/security-settings";

export const metadata = { title: "Security" };

/**
 * Security → the screen that makes revocation, verification and second factors
 * reachable by the person they protect.
 *
 * Everything shown here is read for the signed-in user only; there is no id in
 * the URL and no way to ask about somebody else's sessions.
 */
export default async function SecuritySettings() {
  const actor = await requireActor();

  const [user, sessions, mfa] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: actor.identity.id },
      select: { email: true, emailVerifiedAt: true },
    }),
    listSessions(actor.identity.id),
    mfaStatus(actor.identity.id),
  ]);

  return (
    <div className="space-y-5">
      <EmailVerification
        email={user.email}
        verifiedAt={user.emailVerifiedAt?.toISOString() ?? null}
        mailConfigured={mailConfigured()}
      />

      <ActiveSessions
        sessions={sessions.map((session) => ({
          id: session.id,
          device: session.deviceLabel ?? "Unknown device",
          location: session.ipPrefix,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeenAt.toISOString(),
          current: session.id === actor.identity.sessionId,
        }))}
      />

      <TwoFactor state={mfa} />
    </div>
  );
}
