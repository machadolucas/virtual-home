import { CircleQuestionMark, SignalMedium, Wifi, WifiOff } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "./cn";
import { connectionMeta, statusMeta, type ConnectionState } from "./status";

const GLYPH: Record<ConnectionState, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> =
  {
    connected: Wifi,
    degraded: SignalMedium,
    disconnected: WifiOff,
    unknown: CircleQuestionMark,
  };

export interface ConnectionPillProps {
  state: ConnectionState;
  /** When the state was last observed; rendered as a title, not as a value. */
  since?: string;
  /** Hide the text label below `sm:` (top bars on narrow screens). */
  compact?: boolean;
  className?: string;
}

/**
 * Home Assistant connection indicator for the top bar.
 *
 * The state is measured, not guessed: every render site derives it from
 * `connectionStateOf` over the worker's `integration_status` row, so the
 * header pill and `/settings/home-assistant` always say the same thing. It
 * shows `unknown` rather than optimistically claiming "connected" — an
 * unobserved link is not a working one.
 */
export function ConnectionPill({ state, since, compact = false, className }: ConnectionPillProps) {
  const meta = connectionMeta(state);
  const palette = statusMeta(meta.kind);
  const Glyph = GLYPH[state];
  return (
    <span
      title={since ? `${meta.description} Last change: ${since}.` : meta.description}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2",
        "text-xs font-medium [&_svg]:size-3.5",
        palette.bg,
        palette.fg,
        palette.border,
        className,
      )}
    >
      <Glyph aria-hidden />
      <span className={cn(compact && "sr-only sm:not-sr-only")}>{meta.label}</span>
    </span>
  );
}
