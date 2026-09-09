"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password field with a show/hide control.
 *
 * The whole component is built around one constraint: **it must not touch the
 * value.** A password field is the one input in the product that something
 * other than the user writes to — Chrome's generated-password flow writes
 * straight to the DOM node without dispatching an event React can see — and the
 * P0 this component came out of was caused by React state overwriting exactly
 * that write. So:
 *
 *  - There is no `value`/`onChange` state here. Visibility is the only thing
 *    this component holds, and it is a boolean. A caller that genuinely needs a
 *    controlled field passes `value` and `onChange` through and owns that
 *    decision; every uncontrolled caller stays uncontrolled.
 *  - Toggling changes the `type` attribute on the *same* DOM node. React
 *    updates the attribute in place — the element is never remounted and never
 *    keyed off visibility — so `input.value` survives, whoever wrote it.
 *  - The button is `type="button"`. A bare `<button>` inside a form defaults to
 *    `type="submit"`, which would turn "let me check what I typed" into a
 *    submission.
 *
 * `autoComplete` is required rather than optional. Password managers key off it
 * (`current-password` versus `new-password` decides whether Chrome offers to
 * fill or to generate), and a field that forgot it is the failure this component
 * exists to prevent — so it is not defaultable.
 */
export function PasswordInput({
  className,
  autoComplete,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "autoComplete"> & {
  autoComplete: "current-password" | "new-password";
}) {
  const [visible, setVisible] = React.useState(false);
  const label = visible ? "Hide password" : "Show password";

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        // Room for the button, so a long value never runs underneath it.
        className={cn("pr-10", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        // The accessible name *is* the state: a screen reader reads "Show
        // password, button" and then "Hide password, button". `aria-pressed`
        // carries the same thing for readers that announce toggle state, and
        // the two agree.
        aria-label={label}
        aria-pressed={visible}
        title={label}
        className={cn(
          "absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg",
          "text-faint transition-colors hover:text-body",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/20",
        )}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
