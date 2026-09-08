import { cn } from "./cn";

export interface SkeletonProps {
  className?: string;
  /** Number of stacked lines; widths taper so it reads as text. */
  lines?: number;
  /** Renders a circle (avatars, dots) instead of a bar. */
  circle?: boolean;
  /** Accessible label for a whole loading region. */
  label?: string;
}

/**
 * Static placeholder — deliberately NOT animated. A shimmer is a continuous
 * animation, and this app does not run any. Screen readers get `aria-busy`
 * from the surrounding region instead of a stream of nonsense.
 */
export function Skeleton({ className, lines = 1, circle = false, label }: SkeletonProps) {
  const base = "block rounded-sm bg-surface-3";
  if (circle) {
    return (
      <span
        aria-hidden="true"
        className={cn(base, "rounded-full", className ?? "size-8")}
        data-vh-skeleton=""
      />
    );
  }
  if (lines <= 1) {
    return (
      <span
        aria-hidden="true"
        className={cn(base, "h-4 w-full", className)}
        data-vh-skeleton=""
      />
    );
  }
  const widths = ["w-full", "w-11/12", "w-10/12", "w-9/12", "w-8/12"];
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-busy={label ? true : undefined}
      className={cn("flex flex-col gap-2", className)}
      data-vh-skeleton=""
    >
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(base, "h-4", widths[index % widths.length])}
        />
      ))}
    </span>
  );
}
