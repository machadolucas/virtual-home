import { Ban, Check, CircleQuestionMark, Clock, CloudOff, TriangleAlert } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "./cn";
import { statusMeta, type StatusIcon, type StatusKind } from "./status";

const GLYPH: Record<StatusIcon, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  check: Check,
  clock: Clock,
  alert: TriangleAlert,
  ban: Ban,
  question: CircleQuestionMark,
  "cloud-off": CloudOff,
};

/* -------------------------------------------------------------------------- */
/* StatusDot                                                                   */
/* -------------------------------------------------------------------------- */

export interface StatusDotProps {
  kind: StatusKind;
  /**
   * Accessible name. Pass `null` only when the very same status is already
   * spelled out in adjacent visible text — otherwise the dot is colour-only.
   */
  label?: string | null;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A compact status marker for dense rows. Each kind uses a DIFFERENT GLYPH as
 * well as a different colour, so it survives greyscale and colour blindness.
 */
export function StatusDot({ kind, label, size = "md", className }: StatusDotProps) {
  const meta = statusMeta(kind);
  const Glyph = GLYPH[meta.icon];
  const name = label === null ? null : (label ?? meta.label);
  return (
    <span
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full",
        meta.bg,
        meta.fg,
        size === "sm" ? "size-4 [&_svg]:size-2.5" : "size-5 [&_svg]:size-3.5",
        className,
      )}
    >
      <Glyph aria-hidden />
      {name === null ? null : <span className="sr-only">{name}</span>}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

export type BadgeTone = StatusKind | "neutral" | "accent";

const TONE: Record<"neutral" | "accent", { fg: string; bg: string; border: string }> = {
  neutral: { fg: "text-ink-2", bg: "bg-surface-2", border: "border-line" },
  accent: { fg: "text-accent-text", bg: "bg-accent-soft", border: "border-accent/30" },
};

export interface BadgeProps {
  /** A status kind (adds the matching glyph) or a plain tone. */
  tone?: BadgeTone;
  children: ReactNode;
  /** Override the automatic status glyph, or pass `null` to drop it. */
  icon?: ReactNode | null;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A labelled chip. Because the label is always visible, `Badge` — not
 * `StatusDot` — is the right choice anywhere there is room for words.
 */
export function Badge({ tone = "neutral", children, icon, size = "md", className }: BadgeProps) {
  const isStatus = tone !== "neutral" && tone !== "accent";
  const palette = isStatus ? statusMeta(tone) : TONE[tone];
  let glyph: ReactNode = null;
  if (icon !== null) {
    if (icon !== undefined) glyph = icon;
    else if (isStatus) {
      const Glyph = GLYPH[statusMeta(tone).icon];
      glyph = <Glyph aria-hidden />;
    }
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border font-medium",
        palette.bg,
        palette.fg,
        palette.border,
        size === "sm"
          ? "h-5 px-1.5 text-[0.6875rem] [&_svg]:size-3"
          : "h-6 px-2 text-xs [&_svg]:size-3.5",
        className,
      )}
    >
      {glyph}
      {children}
    </span>
  );
}

/** `Badge` pre-filled from a status kind's own label. */
export function StatusBadge({
  kind,
  size,
  className,
}: {
  kind: StatusKind;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <Badge tone={kind} size={size} className={className}>
      {statusMeta(kind).label}
    </Badge>
  );
}
