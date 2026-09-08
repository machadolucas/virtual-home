import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, focusRing } from "./cn";
import { Spinner } from "./Spinner";
import type { ButtonVariant } from "./Button";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent border border-transparent hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-surface-3 active:bg-surface-4",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:bg-surface-3 hover:text-ink active:bg-surface-4",
  danger:
    "bg-transparent text-overdue border border-transparent hover:bg-overdue-soft active:bg-overdue-soft",
};

export type IconButtonSize = "sm" | "md" | "lg";

/**
 * Boxes, not just glyphs: 28 px at `sm` (above the 24 px floor), and every size
 * grows to a 44 px touch target below `md:` so phones get a real target
 * without loosening desktop density.
 */
const SIZE: Record<IconButtonSize, string> = {
  sm: "size-11 md:size-7 [&_svg]:size-4",
  md: "size-11 md:size-9 [&_svg]:size-[1.125rem]",
  lg: "size-12 [&_svg]:size-5",
};

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  /** Required: an icon-only control must still have an accessible name. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  /** Renders the label visibly next to the icon (used in collapsed sidebars). */
  showLabel?: boolean;
}

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  loading = false,
  showLabel = false,
  className,
  disabled,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      aria-label={showLabel ? undefined : label}
      title={showLabel ? undefined : label}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-md",
        "transition-colors duration-100",
        "disabled:pointer-events-none disabled:opacity-55",
        focusRing,
        VARIANT[variant],
        SIZE[size],
        showLabel && "w-auto gap-2 px-2.5 text-sm font-medium",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {showLabel ? <span>{label}</span> : null}
    </button>
  );
}
