import { LoaderCircle } from "lucide-react";
import { cn } from "./cn";

/**
 * Busy indicator. The only looping animation in the app; `globals.css` stops
 * the loop under `prefers-reduced-motion`, leaving a static glyph.
 *
 * Decorative by default — the surrounding control owns the accessible name and
 * `aria-busy`.
 */
export function Spinner({
  className,
  label,
}: {
  className?: string;
  /** Provide when the spinner is the only thing on screen. */
  label?: string;
}) {
  return (
    <>
      <LoaderCircle
        aria-hidden="true"
        className={cn("vh-spin size-4 shrink-0", className)}
        strokeWidth={2.25}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}
