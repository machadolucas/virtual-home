import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, focusRing } from "./cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent border border-transparent hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-surface-3 active:bg-surface-4",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:bg-surface-3 hover:text-ink active:bg-surface-4",
  danger:
    "bg-transparent text-overdue border border-overdue/45 hover:bg-overdue-soft active:bg-overdue-soft",
};

/** Heights: 24 px floor is never reached — the smallest button is 32 px tall. */
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-[0.8125rem]",
  md: "h-9 gap-2 px-3 text-sm",
  lg: "h-11 gap-2 px-4 text-[0.9375rem]",
};

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/**
 * The button look as a class string, so anchors and `Link`s can be styled
 * identically without nesting a `<button>` inside an `<a>`.
 */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  fullWidth = false,
}: ButtonClassOptions = {}): string {
  return cn(
    "inline-flex select-none items-center justify-center whitespace-nowrap rounded-md font-medium",
    "transition-colors duration-100",
    "disabled:pointer-events-none disabled:opacity-55",
    "aria-disabled:pointer-events-none aria-disabled:opacity-55",
    focusRing,
    VARIANT[variant],
    SIZE[size],
    fullWidth && "w-full",
  );
}

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner, disables the button and marks it `aria-busy`. */
  loading?: boolean;
  /** Leading glyph. Decorative — keep the label in `children`. */
  icon?: ReactNode;
  /** Trailing glyph (chevrons, external-link marks). */
  iconTrailing?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  fullWidth,
  loading = false,
  icon,
  iconTrailing,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses({ variant, size, fullWidth }), className)}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconTrailing}
    </button>
  );
}
