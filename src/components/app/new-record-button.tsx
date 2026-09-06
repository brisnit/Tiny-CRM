"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { QuickAddKind } from "@/components/app/quick-add";

/**
 * Opens the shell's Quick Add dialog with a specific record type preselected.
 * Uses a custom event rather than context so any page — including deeply nested
 * server components — can trigger it without threading props through.
 */
export function NewRecordButton({
  kind,
  label,
  variant = "brand",
  size = "sm",
  prefill,
}: {
  kind: QuickAddKind;
  label: string;
  variant?: "brand" | "outline" | "ghost" | "subtle";
  size?: "xs" | "sm" | "md";
  prefill?: Record<string, string>;
}) {
  return (
    <Button
      variant={variant}
      size={size}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("tinycrm:quick-add", { detail: { kind, prefill } }),
        )
      }
    >
      <Plus className="size-3.5" />
      {label}
    </Button>
  );
}
