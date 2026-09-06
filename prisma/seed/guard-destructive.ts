/**
 * Side-effecting guard for the destructive demo seed.
 *
 * Imported for its side effect, first, so it runs before `./helpers` constructs
 * a Prisma client.
 */
import { assertSafeToSeed } from "./guard";

assertSafeToSeed("destructive");
