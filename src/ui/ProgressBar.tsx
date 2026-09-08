import { cn } from "./cn";

export interface ProgressBarProps {
  /** Current value in `[0, max]`. Omit for an indeterminate bar. */
  value?: number;
  max?: number;
  /** Accessible name, e.g. "Model import". Required. */
  label: string;
  /** Show the label and the numeric value above the track. */
  showLabel?: boolean;
  /** Text shown instead of "n/max" (e.g. "3 of 8 rooms"). */
  valueText?: string;
  tone?: "accent" | "ok" | "due" | "overdue";
  size?: "sm" | "md";
  className?: string;
}

const TONE = {
  accent: "bg-accent",
  ok: "bg-ok",
  due: "bg-due",
  overdue: "bg-overdue",
} as const;

/**
 * Determinate progress only ever moves when new data arrives, so there is no
 * animation here. An indeterminate bar renders as a static striped track
 * rather than a moving one — this app runs no continuous animations.
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  showLabel = false,
  valueText,
  tone = "accent",
  size = "md",
  className,
}: ProgressBarProps) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const clamped = determinate ? Math.min(Math.max(value, 0), max) : 0;
  const pct = determinate && max > 0 ? (clamped / max) * 100 : 0;
  const text = valueText ?? (determinate ? `${clamped} of ${max}` : "In progress");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {showLabel ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-ink-2">{label}</span>
          <span className="vh-tnum text-ink-3">{text}</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? max : undefined}
        aria-valuenow={determinate ? clamped : undefined}
        aria-valuetext={text}
        className={cn(
          "w-full overflow-hidden rounded-full bg-surface-3",
          size === "sm" ? "h-1.5" : "h-2",
        )}
      >
        {determinate ? (
          <div
            className={cn("h-full rounded-full", TONE[tone])}
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div
            className="h-full w-full rounded-full opacity-45"
            style={{
              backgroundImage:
                "repeating-linear-gradient(115deg, var(--vh-line-strong) 0 6px, transparent 6px 12px)",
            }}
          />
        )}
      </div>
    </div>
  );
}
