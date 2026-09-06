"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Opens Tiny AI focused on this record. */
export function AskAiButton({
  focus,
  question,
  label = "Ask Tiny AI",
  variant = "outline",
  size = "sm",
}: {
  focus?: { type: "contact" | "company" | "deal" | "project" | "opportunity"; id: string; label: string };
  question?: string;
  label?: string;
  variant?: "brand" | "outline" | "ghost" | "subtle";
  size?: "xs" | "sm" | "md";
}) {
  return (
    <Button
      variant={variant}
      size={size}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("tinycrm:ask-ai", { detail: { focus: focus ?? null, question: question ?? null } }),
        )
      }
    >
      <Sparkles className="size-3.5 text-brand-500" />
      {label}
    </Button>
  );
}
