"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "text-[13px] font-medium text-body select-none peer-disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Label + control + optional hint, the shape every form row in the app uses.
 *
 * The label is associated with its control automatically.
 *
 * Every dialog in the product rendered its labels as adjacent text with no
 * `for`, no `aria-label` and no `id` on the input. Playwright's `getByLabel`
 * matched nothing for any field in any create dialog, which is the same thing a
 * screen reader sees: "edit text, blank". Password managers had nothing to
 * match on either.
 *
 * Fixing it here rather than at each of the several dozen call sites means a
 * field added later is correct by default, which is the only version of this
 * that stays true.
 *
 * `htmlFor` still wins when a caller passes one — several already do, pointing
 * at controls this cannot reach.
 */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className,
  children,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const generated = React.useId();
  const controlId = htmlFor ?? generated;

  // Give the control the id the label points at, unless it brought its own.
  // Only a single element child is adopted: anything else is left untouched
  // rather than guessed at.
  const control = React.isValidElement<{ id?: string }>(children) && !children.props.id
    ? React.cloneElement(children, { id: controlId })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <Label htmlFor={controlId}>
          {label}
          {required ? <span className="text-brand-500"> *</span> : null}
        </Label>
      ) : null}
      {control}
      {error ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}
