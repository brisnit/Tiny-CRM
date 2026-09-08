import { Workflow } from "lucide-react";

import { BetaUnavailable } from "@/components/app/beta-unavailable";
import { requireActor } from "@/lib/auth/access";

export const metadata = { title: "Automations" };

/**
 * Held back from the private beta.
 *
 * The screen described what an automation is — a trigger, some conditions and
 * an action — and provided no way to create one. That is a promise the product
 * does not keep yet, and a primary navigation entry made the promise louder.
 *
 * The engine itself is real and still runs: automations fire from the outbox in
 * src/lib/automations.ts, and the rules that exist keep working. What is not
 * built is the part a customer would need — a way to author one. The previous
 * read-only listing lives in git history and can come back with the builder.
 */
export default async function AutomationsPage() {
  // Still behind the same authorization as every other route.
  await requireActor();

  return (
    <BetaUnavailable
      title="Automations"
      icon={Workflow}
      what="Small rules that keep the CRM tidy without you thinking about it."
      why="Automations run behind the scenes, but there is no way to write your own yet. Rather than show you a builder that does not work, we have held the screen back until it does."
    />
  );
}
