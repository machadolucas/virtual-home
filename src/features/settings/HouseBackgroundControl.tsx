"use client";
/**
 * The 3D view's background, as a control.
 *
 * One component, two homes: the House workspace's **Rendering** section and Settings → Household's
 * **Appearance** panel. The same control in both places because it is the same household setting —
 * and because the House page is where you can actually see what you are choosing.
 *
 * Optimistic: `onPreview` repaints the canvas host on the keystroke, and a failed write reverts to
 * the value the server last confirmed. A background that looks saved and is not is worse than one
 * that snaps back.
 *
 * It lives in `features/settings` rather than in `src/house` so the settings page can import it
 * without pulling three into that bundle — `model/background.ts` is pure, and so is this.
 */
import { useEffect, useRef, useState } from "react";
import {
  backgroundStyle,
  presetIdOf,
  sameBackground,
  DEFAULT_GRADIENT_ANGLE_DEG,
  DEFAULT_HOUSE_BACKGROUND,
  HOUSE_BACKGROUND_PRESETS,
  type HouseBackground,
} from "@/house/model/background";
import { updateHouseBackground } from "@/server/actions/settings/household";
import { useAction } from "@/features/settings/actionClient";
import { Button, SegmentedControl, cn, focusRing } from "@/ui";

/** One write per settled decision, not one per pointer move. Mirrors the colour picker's 600 ms. */
const SAVE_DEBOUNCE_MS = 600;

/** The last solid / gradient the user typed, so switching modes does not lose it. */
interface Drafts {
  solid: { mode: "solid"; color: string };
  gradient: { mode: "gradient"; from: string; to: string; angleDeg: number };
}

const INITIAL_DRAFTS: Drafts = {
  solid: { mode: "solid", color: "#14161a" },
  gradient: {
    mode: "gradient",
    from: "#1b2430",
    to: "#0b0d10",
    angleDeg: DEFAULT_GRADIENT_ANGLE_DEG,
  },
};

export interface HouseBackgroundControlProps {
  /** What the server last confirmed. */
  value: HouseBackground;
  /**
   * Called on every change, before the write lands, and again with the previous value if the write
   * fails. The House workspace paints the canvas host from this; Settings has nothing to preview,
   * so it omits it.
   */
  onPreview?: (background: HouseBackground) => void;
  /** `compact` is the workspace's right panel; `full` is the settings panel. */
  layout?: "compact" | "full";
  className?: string;
}

export function HouseBackgroundControl({
  value,
  onPreview,
  layout = "compact",
  className,
}: HouseBackgroundControlProps) {
  const [confirmed, setConfirmed] = useState(value);
  const [drafts, setDrafts] = useState<Drafts>(() => seedDrafts(value));

  /**
   * The server is the authority: a value that arrives from a revalidate (or from the other member
   * changing it) replaces what this control thinks is current.
   *
   * Adjusted during render against the previous prop rather than in an effect — the effect version
   * is a cascading re-render, and React documents this as the way to reset state from a prop.
   */
  const [syncedFrom, setSyncedFrom] = useState(value);
  if (syncedFrom !== value && !sameBackground(syncedFrom, value)) {
    setSyncedFrom(value);
    setConfirmed(value);
    setDrafts(seedDrafts(value));
  }

  /**
   * The value to go back to if the write fails. Captured when the write starts, not read when it
   * fails: by then `confirmed` already holds the optimistic value.
   */
  const revertTo = useRef<HouseBackground | null>(null);

  const call = useAction(updateHouseBackground, {
    onSuccess: () => {
      revertTo.current = null;
    },
    onError: () => {
      const previous = revertTo.current;
      revertTo.current = null;
      if (!previous) return;
      // `useAction` has already said what failed; this puts the picture back so the control, the
      // canvas and the database agree again.
      setConfirmed(previous);
      setDrafts(seedDrafts(previous));
      onPreview?.(previous);
    },
  });

  /**
   * Apply optimistically, then write once the picker settles.
   *
   * `<input type="color">` and the range slider both fire on every pointer move, so the write is
   * debounced exactly the way surface colours are (`HouseWorkspace`'s `useColorPersistence`): the
   * picture follows the finger, the database gets one row per decision.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const commit = (next: HouseBackground): void => {
    if (timer.current) clearTimeout(timer.current);
    // Only the first change in a burst records what to revert to.
    if (revertTo.current === null) revertTo.current = confirmed;
    setConfirmed(next);
    onPreview?.(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      call.run({ background: next });
    }, SAVE_DEBOUNCE_MS);
  };

  const mode = confirmed.mode;
  const activePreset = presetIdOf(confirmed);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SegmentedControl
        ariaLabel="3D background"
        size="sm"
        fullWidth={layout === "compact"}
        value={mode}
        onValueChange={(next) => {
          if (next === "theme") commit(DEFAULT_HOUSE_BACKGROUND);
          else if (next === "solid") commit(drafts.solid);
          else commit(drafts.gradient);
        }}
        items={[
          { value: "theme", label: "Theme" },
          { value: "solid", label: "Colour" },
          { value: "gradient", label: "Gradient" },
        ]}
      />

      {mode === "theme" ? (
        <p className="text-[11px] leading-4 text-ink-3">
          The view follows the interface theme — light on paper, dark on a deep neutral.
        </p>
      ) : null}

      {mode === "solid" ? (
        <ColorRow
          label="Background colour"
          value={drafts.solid.color}
          onChange={(color) => {
            const next = { mode: "solid" as const, color };
            setDrafts((d) => ({ ...d, solid: next }));
            commit(next);
          }}
        />
      ) : null}

      {mode === "gradient" ? (
        <div className="flex flex-col gap-2">
          <ColorRow
            label="Gradient start"
            value={drafts.gradient.from}
            onChange={(from) => {
              const next = { ...drafts.gradient, from };
              setDrafts((d) => ({ ...d, gradient: next }));
              commit(next);
            }}
          />
          <ColorRow
            label="Gradient end"
            value={drafts.gradient.to}
            onChange={(to) => {
              const next = { ...drafts.gradient, to };
              setDrafts((d) => ({ ...d, gradient: next }));
              commit(next);
            }}
          />
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            <span>
              Direction <span className="font-mono text-ink-2">{drafts.gradient.angleDeg}°</span>{" "}
              (180° is top to bottom)
            </span>
            <input
              type="range"
              min={0}
              max={360}
              step={15}
              value={drafts.gradient.angleDeg}
              aria-label="Gradient direction in degrees"
              className={cn("h-touch w-full touch-manipulation md:h-8", focusRing)}
              onChange={(event) => {
                const angleDeg = Number(event.currentTarget.value);
                if (!Number.isFinite(angleDeg)) return;
                const next = { ...drafts.gradient, angleDeg };
                setDrafts((d) => ({ ...d, gradient: next }));
                commit(next);
              }}
            />
          </label>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-1">
        <legend className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
          Presets
        </legend>
        <div className="flex flex-wrap gap-1">
          {HOUSE_BACKGROUND_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={activePreset === preset.id}
              onClick={() => {
                setDrafts(seedDrafts(preset.value));
                commit(preset.value);
              }}
              className={cn(
                "inline-flex min-h-touch items-center gap-1.5 rounded-md border px-2 text-[11px]",
                "font-medium transition-colors duration-100 md:min-h-8",
                activePreset === preset.id
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-line bg-surface text-ink hover:bg-surface-3",
                focusRing,
              )}
            >
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 rounded-xs border border-line bg-viewport"
                style={backgroundStyle(preset.value)}
              />
              {preset.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={sameBackground(confirmed, DEFAULT_HOUSE_BACKGROUND) || call.pending}
          onClick={() => {
            setDrafts(INITIAL_DRAFTS);
            commit(DEFAULT_HOUSE_BACKGROUND);
          }}
        >
          Reset
        </Button>
        {call.pending ? <span className="text-[11px] text-ink-3">Saving…</span> : null}
      </div>

      <p className="text-[11px] leading-4 text-ink-3">
        This is a household setting, like the time zone: both of you see the same view.
      </p>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-ink-2">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value.toLowerCase())}
        aria-label={label}
        className={cn(
          "h-8 w-11 shrink-0 cursor-pointer rounded-sm border border-line-strong bg-surface-2",
          focusRing,
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-ink-3">{value}</span>
    </label>
  );
}

/** Seed both drafts from a stored value, so the editors open on what is actually on screen. */
function seedDrafts(value: HouseBackground): Drafts {
  return {
    solid: value.mode === "solid" ? { mode: "solid", color: value.color } : INITIAL_DRAFTS.solid,
    gradient:
      value.mode === "gradient"
        ? {
            mode: "gradient",
            from: value.from,
            to: value.to,
            angleDeg: value.angleDeg ?? DEFAULT_GRADIENT_ANGLE_DEG,
          }
        : INITIAL_DRAFTS.gradient,
  };
}
