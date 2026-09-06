import "server-only";

import { AppError } from "@/lib/errors";

/**
 * Typed-confirmation guard for destructive operations.
 *
 * The dialog asks the user to retype the record's name; this verifies it on the
 * server. UI confirmation alone is not a control — a direct call to the action
 * would skip it entirely — so the check lives where the deletion happens.
 *
 * Comparison is case- and whitespace-insensitive but otherwise exact, so a
 * mistyped or pasted-wrong name cannot delete the wrong record.
 */
export function assertConfirmation(supplied: string | null | undefined, expected: string): void {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!supplied || normalise(supplied) !== normalise(expected)) {
    throw new AppError("validation", `Type "${expected}" exactly to confirm.`, {
      meta: { field: "confirmation", expected },
    });
  }
}
