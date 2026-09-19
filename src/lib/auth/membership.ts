import type { Prisma } from "@/generated/prisma/client";

import { isPostgres } from "@/lib/env";

/**
 * Serialises everything that changes one person's access.
 *
 * Most of the invariants in this area are held by constraints: the unique index
 * on a grant stops duplicates, the foreign key stops a grant outliving its
 * membership. One is not, and it is the reason this exists.
 *
 * Two administrators replacing the same person's grant set at the same moment,
 * starting from *no* existing grants, delete nothing and then each insert their
 * own anchors. Neither delete blocks the other, because there are no rows to
 * lock, and the unique index is satisfied by both — so the person ends up with
 * the union of two sets, which is an access level nobody chose. Starting from a
 * non-empty set the deletes do collide and the last writer wins cleanly, which
 * is why this is easy to miss.
 *
 * Taking the membership row itself is enough: every path that changes what this
 * person can reach — scope transitions, grants, revocations — passes through
 * here first, so they queue behind one another rather than interleaving. The
 * lock is held for the rest of the surrounding transaction, which is one
 * statement or two.
 *
 * SQLite takes a single write lock for the whole database, so there is nothing
 * to add there.
 */
export async function lockMembership(
  client: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!isPostgres) return;
  await client.$queryRaw`
    SELECT id FROM "WorkspaceMember"
    WHERE "workspaceId" = ${workspaceId} AND "userId" = ${userId}
    FOR UPDATE`;
}
