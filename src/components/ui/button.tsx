"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The pill shape is the brand's signature (see the brand sheet CTAs), so it is
 * the default. Dense table and toolbar controls opt into `shape="rounded"`.
 */
const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        brand:
          "bg-brand-500 text-white hover:bg-brand-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.14)]",
        accent: "bg-brand-400 text-brand-950 hover:bg-brand-300",
        default:
          "bg-ink text-white hover:bg-ink/90 dark:bg-white dark:text-ink dark:hover:bg-white/90",
        outline:
          "border border-hairline-strong bg-panel text-body hover:bg-sunken hover:border-hairline-strong",
        ghost: "text-muted hover:bg-sunken hover:text-body",
        subtle: "bg-sunken text-body hover:bg-hairline",
        danger: "bg-rose-600 text-white hover:bg-rose-700",
        link: "text-brand-600 underline-offset-4 hover:underline dark:text-brand-400",
      },
      size: {
        xs: "h-7 px-2.5 text-xs",
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4 text-sm",
        lg: "h-11 px-6 text-[15px]",
        xl: "h-12 px-7 text-base",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7",
      },
      shape: {
        pill: "rounded-full",
        rounded: "rounded-lg",
      },
    },
    compoundVariants: [
      { size: "icon", shape: "pill", class: "rounded-lg" },
      { size: "icon-sm", shape: "pill", class: "rounded-lg" },
      { size: "icon-xs", shape: "pill", class: "rounded-md" },
    ],
    defaultVariants: { variant: "default", size: "md", shape: "pill" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  shape,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  // `asChild` hands rendering to the child element (usually a Link), and Radix's
  // Slot requires exactly one child — so the loading affordance, which would be
  // a second child, is only available on real buttons.
  if (asChild) {
    return (
      <Slot
        data-slot="button"
        className={cn(buttonVariants({ variant, size, shape }), className)}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, size, shape }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span className="sr-only">Working…</span>
        </>
      ) : null}
      <span className={cn("contents", loading && "opacity-70")}>{children}</span>
    </button>
  );
}

export { buttonVariants };
