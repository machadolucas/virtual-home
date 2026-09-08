/**
 * The 3D view's background, as household configuration.
 *
 * Pure and dependency-light on purpose: this module is imported by the viewer (a client bundle that
 * pulls in three), by the settings page, and by the server action that validates the write. Nothing
 * here may reach for `three`, the DOM or the database, or one of those three callers breaks.
 *
 * The background is **CSS on the canvas host**, not a scene texture — see `docs/decisions.md`
 * (D-0xx, "the 3D background is CSS"). `mode: "theme"` means "no inline style at all": the host
 * carries `bg-viewport` and the token follows light/dark like everything else.
 */
import type { CSSProperties } from "react";
import { z } from "zod";

export type HouseBackground =
  | { mode: "theme" }
  | { mode: "solid"; color: string }
  | { mode: "gradient"; from: string; to: string; angleDeg?: number };

/**
 * Lowercase `#rrggbb`, the same shape `user.display_color` uses.
 *
 * Lowercase rather than case-insensitive so a stored value has exactly one spelling — `presetIdOf`
 * compares colours as strings, and two spellings of the same colour would stop matching a preset.
 * `<input type="color">` already emits lowercase.
 */
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-f]{6}$/, "expected a lowercase #rrggbb colour");

/**
 * A CSS gradient angle in degrees. Bounded to one full turn rather than left open: a stored 7200
 * would render identically to 0 and read as a corrupted value in the database.
 */
const angleDeg = z.number().int().min(0).max(360);

export const houseBackgroundSchema: z.ZodType<HouseBackground> = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("theme") }),
  z.object({ mode: z.literal("solid"), color: hexColor }),
  z.object({
    mode: z.literal("gradient"),
    from: hexColor,
    to: hexColor,
    angleDeg: angleDeg.optional(),
  }),
]);

/** Follow the theme. This is also what a NULL column and a malformed stored value resolve to. */
export const DEFAULT_HOUSE_BACKGROUND: HouseBackground = { mode: "theme" };

/** CSS's own default for `linear-gradient`: top → bottom. */
export const DEFAULT_GRADIENT_ANGLE_DEG = 180;

/**
 * Presets.
 *
 * Each one is a real choice a household might make rather than a swatch: follow the theme, a flat
 * neutral to judge colours against, a cool vertical fade that reads as depth, and a warm pale
 * ground for looking at the model in daylight. Named for what they are — there is no brand here to
 * invent a name for.
 */
export const HOUSE_BACKGROUND_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  value: HouseBackground;
}> = [
  { id: "theme", label: "Follows the theme", value: { mode: "theme" } },
  { id: "studio-dark", label: "Flat dark neutral", value: { mode: "solid", color: "#14161a" } },
  {
    id: "dusk",
    label: "Cool fade, dark",
    value: { mode: "gradient", from: "#1b2430", to: "#0b0d10", angleDeg: 180 },
  },
  { id: "paper", label: "Warm paper, light", value: { mode: "solid", color: "#f4f4f2" } },
  {
    id: "daylight",
    label: "Cool fade, light",
    value: { mode: "gradient", from: "#e9eef4", to: "#fbfbfa", angleDeg: 180 },
  },
];

/**
 * The inline style for the canvas host.
 *
 * `{}` for `theme`, deliberately: an empty style object leaves the host's `bg-viewport` class in
 * charge, so the token — and therefore light/dark — wins with nothing to override it.
 */
export function backgroundStyle(bg: HouseBackground): CSSProperties {
  switch (bg.mode) {
    case "solid":
      return { backgroundColor: bg.color };
    case "gradient": {
      const angle = bg.angleDeg ?? DEFAULT_GRADIENT_ANGLE_DEG;
      return { backgroundImage: `linear-gradient(${angle}deg, ${bg.from} 0%, ${bg.to} 100%)` };
    }
    case "theme":
    default:
      return {};
  }
}

/**
 * Parse a value that came out of the database (or off the wire).
 *
 * A malformed value is **not** an error the household should see on the House page: the viewer
 * falls back to the theme, which is always correct, and the caller logs it once.
 */
export function parseHouseBackground(value: unknown): {
  background: HouseBackground;
  malformed: boolean;
} {
  if (value === null || value === undefined)
    return { background: DEFAULT_HOUSE_BACKGROUND, malformed: false };
  const raw = typeof value === "string" ? safeJson(value) : value;
  const parsed = houseBackgroundSchema.safeParse(raw);
  return parsed.success
    ? { background: parsed.data, malformed: false }
    : { background: DEFAULT_HOUSE_BACKGROUND, malformed: true };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Which preset a stored background corresponds to, or `null` for a hand-picked colour. */
export function presetIdOf(bg: HouseBackground): string | null {
  return HOUSE_BACKGROUND_PRESETS.find((preset) => sameBackground(preset.value, bg))?.id ?? null;
}

/**
 * Field-by-field, not `JSON.stringify`: two objects with the same values in a different key order
 * are the same background, and an absent `angleDeg` is the default rather than a different value.
 */
export function sameBackground(a: HouseBackground, b: HouseBackground): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "solid" && b.mode === "solid") return a.color === b.color;
  if (a.mode === "gradient" && b.mode === "gradient")
    return (
      a.from === b.from &&
      a.to === b.to &&
      (a.angleDeg ?? DEFAULT_GRADIENT_ANGLE_DEG) === (b.angleDeg ?? DEFAULT_GRADIENT_ANGLE_DEG)
    );
  return true; // both "theme"
}
