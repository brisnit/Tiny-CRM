"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex items-center gap-1 overflow-x-auto border-b border-hairline",
        className,
      )}
      {...props}
    />
  );
}

/** Underlined tabs — quieter than a pill group, and they scale to many items. */
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative -mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-muted transition-colors",
        "hover:text-body",
        "data-[state=active]:border-brand-500 data-[state=active]:text-body",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("focus-visible:outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0", className)}
      {...props}
    />
  );
}
