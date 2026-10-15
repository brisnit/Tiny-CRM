import "server-only";

import type { Prisma } from "@/generated/prisma/client";

/**
 * Which contact, if any, an imported message belongs to.
 *
 * ## Three conditions, all required
 *
 * A link is made only when there is **one** contact, matched on an **exact**
 * email address, that the connecting person can **already see**. Anything else
 * leaves the message unlinked for them to attach by hand.
 *
 * Each condition earns its place:
 *
 *   - **Exact, not fuzzy.** Matching on a name, a domain, or a normalised
 *     variant guesses, and a wrong guess files somebody's correspondence
 *     against the wrong company — visibly, on a shared record.
 *   - **Unambiguous.** Two contacts sharing an address is uncommon but real
 *     (a shared `info@`, a duplicate not yet merged). Picking the first is a
 *     coin toss recorded as a fact, so neither is chosen.
 *   - **Accessible.** A restricted member must not have their mail linked to a
 *     contact they are not permitted to see. The link would be invisible to
 *     them and visible in its effects to others, which is the worst of both.
 *
 * ## Linking does not share
 *
 * A linked message stays `private` to its owner. The association is a property
 * of a private row, and the row is what row-level security gates — so a
 * colleague looking at the same contact sees no subject, no snippet, and no
 * count. That is asserted against PostgreSQL in
 * tests/security/integration-sync-privacy.test.ts, because it is the claim a
 * customer is most entitled to rely on and the easiest to break by adding a
 * convenience query later.
 */

export type AssociationCandidate = {
  /** Lower-cased, trimmed. */
  email: string;
};

export type Association =
  | { contactId: string; reason: "exact-unique" }
  | { contactId: null; reason: "no-match" | "ambiguous" | "not-accessible" | "no-address" };

/**
 * Resolves the contact for one message.
 *
 * `tx` is the caller's transaction, and `visibleContactWhere` is the caller's
 * own access scope — this module never decides what the person may see, it
 * only refuses to link to anything outside it.
 */
export async function associateContact(
  tx: Prisma.TransactionClient,
  input: {
    addresses: string[];
    workspaceId: string;
    /** The scope clause the connecting person reads contacts through. */
    visibleContactWhere: Record<string, unknown>;
  },
): Promise<Association> {
  const addresses = normalise(input.addresses);
  if (addresses.length === 0) return { contactId: null, reason: "no-address" };

  // Every contact in the workspace with one of these addresses, ignoring
  // visibility for the moment — so "ambiguous" and "not accessible" can be
  // told apart, which matters because they are different answers to the
  // customer and one of them is a privacy outcome rather than a data one.
  const all = await tx.contact.findMany({
    where: { workspaceId: input.workspaceId, email: { in: addresses } },
    select: { id: true, email: true },
  });
  if (all.length === 0) return { contactId: null, reason: "no-match" };

  // Ambiguity is judged per address: two contacts sharing one address is the
  // collision that matters. A message to two different people who are each
  // unambiguous is not ambiguous — it is simply addressed to two contacts, and
  // the first in our priority order wins.
  for (const address of addresses) {
    const matches = all.filter((c) => c.email?.toLowerCase() === address);
    if (matches.length === 0) continue;
    if (matches.length > 1) return { contactId: null, reason: "ambiguous" };

    const candidate = matches[0]!;
    // `AND`, not a spread. Spreading the caller's scope and then setting `id`
    // **overwrites** any `id` constraint it carried — and a restricted
    // member's scope is exactly that: `id: { in: [...the records they were
    // granted] }`. The first version did this and silently linked a message to
    // a contact its owner is not permitted to see; the test caught it.
    const visible = await tx.contact.findFirst({
      where: { AND: [input.visibleContactWhere, { id: candidate.id }] },
      select: { id: true },
    });
    if (!visible) return { contactId: null, reason: "not-accessible" };
    return { contactId: candidate.id, reason: "exact-unique" };
  }
  return { contactId: null, reason: "no-match" };
}

/**
 * Addresses in the order they should be tried: the other party first.
 *
 * For received mail the sender is the counterparty; for sent mail it is the
 * recipient. The connected account's own address is dropped, because filing a
 * message against yourself is never the useful answer.
 */
export function candidateAddresses(input: {
  from: string | null | undefined;
  to: (string | null | undefined)[];
  accountEmail: string | null;
}): string[] {
  const own = input.accountEmail?.trim().toLowerCase() ?? null;
  const ordered = [input.from, ...input.to];
  return normalise(ordered).filter((address) => address !== own);
}

function normalise(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const address = value?.trim().toLowerCase();
    // A bare sanity check, not validation: Graph gives us whatever the message
    // carried, and a malformed address should be skipped rather than matched.
    if (!address || !address.includes("@") || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}
