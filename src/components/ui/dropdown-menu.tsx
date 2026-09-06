"use client";

import * as React from "react";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuSub = Primitive.Sub;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

const surface =
  "z-50 min-w-[10rem] overflow-hidden rounded-xl border border-hairline bg-panel p-1 shadow-pop " +
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 " +
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95";

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content sideOffset={sideOffset} className={cn(surface, className)} {...props} />
    </Primitive.Portal>
  );
}

const itemStyles =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-body outline-none transition-colors " +
  "focus:bg-sunken data-[highlighted]:bg-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-faint";

export function DropdownMenuItem({
  className,
  danger,
  ...props
}: React.ComponentProps<typeof Primitive.Item> & { danger?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        itemStyles,
        danger && "text-rose-600 focus:bg-rose-50 dark:text-rose-400 dark:focus:bg-rose-950/40 [&_svg]:text-rose-500",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem className={cn(itemStyles, "pr-8", className)} checked={checked} {...props}>
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check className="size-3.5 text-brand-500" />
        </Primitive.ItemIndicator>
      </span>
    </Primitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem className={cn(itemStyles, "pr-8", className)} {...props}>
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check className="size-3.5 text-brand-500" />
        </Primitive.ItemIndicator>
      </span>
    </Primitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-hairline", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("ml-auto text-[11px] tracking-widest text-faint tabular", className)} {...props} />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger className={cn(itemStyles, className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-4" />
    </Primitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent className={cn(surface, className)} {...props} />
    </Primitive.Portal>
  );
}
