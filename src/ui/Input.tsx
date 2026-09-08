import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, focusRing } from "./cn";

export type InputSize = "sm" | "md" | "lg";

const SIZE: Record<InputSize, string> = {
  sm: "h-8 px-2 text-[0.8125rem]",
  md: "h-9 px-2.5 text-sm",
  lg: "h-11 px-3 text-base",
};

/** Shared field chrome, reused by `Textarea` and the shell's search box. */
export const fieldSurface = cn(
  "w-full rounded-sm border bg-surface-2 text-ink",
  "border-line-strong placeholder:text-ink-3",
  "transition-colors duration-100",
  "hover:border-ink-3",
  "disabled:cursor-not-allowed disabled:opacity-60",
  "aria-[invalid=true]:border-overdue aria-[invalid=true]:bg-overdue-soft",
  focusRing,
);

export interface InputProps extends Omit<ComponentPropsWithRef<"input">, "size"> {
  inputSize?: InputSize;
  /** Leading glyph rendered inside the field (search, units). Decorative. */
  icon?: ReactNode;
  /** Trailing content: a clear button, a unit suffix, a keyboard hint. */
  trailing?: ReactNode;
}

export function Input({ inputSize = "md", icon, trailing, className, ...rest }: InputProps) {
  const input = (
    <input
      className={cn(
        fieldSurface,
        SIZE[inputSize],
        icon ? "pl-8" : undefined,
        trailing ? "pr-9" : undefined,
        className,
      )}
      {...rest}
    />
  );
  if (!icon && !trailing) return input;
  return (
    <span className="relative block w-full">
      {icon ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 [&_svg]:size-4"
        >
          {icon}
        </span>
      ) : null}
      {input}
      {trailing ? (
        <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 text-ink-3">
          {trailing}
        </span>
      ) : null}
    </span>
  );
}
