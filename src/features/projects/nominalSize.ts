/**
 * `infra_route.nominal_size` is free text ("DN20", "Cat6a", "125/80") because that is what is
 * written on the part. The 3D workspace, on the other hand, needs a **number** in metres to draw a
 * duct at its real diameter.
 *
 * Rather than add a column, the two live in one field with a canonical spelling for the numeric
 * case, so a size the workspace set round-trips exactly and a size a human typed is never mangled:
 *
 *   `Ø125 mm`  ⇄  `{ diameterM: 0.125 }`
 *   `W600 mm`  ⇄  `{ widthM: 0.6 }`
 *   `DN20`     ⇄  `{}` — kept verbatim, no numeric size
 *
 * Millimetres, not metres, in the text: that is the unit a duct or a pipe is actually specified in,
 * and it keeps the stored string readable in a CSV export.
 */
export interface NumericSize {
  diameterM?: number;
  widthM?: number;
}

const DIAMETER_RE = /^Ø\s*(\d+(?:\.\d+)?)\s*mm$/;
const WIDTH_RE = /^W\s*(\d+(?:\.\d+)?)\s*mm$/;

const mm = (metres: number): string => {
  const value = Math.round(metres * 1000 * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/**
 * The text to store. An explicit `nominalSize` always wins — a human's "DN20" is more informative
 * than a derived diameter, and the two are not in conflict often enough to justify a second field.
 */
export function formatNominalSize(input: {
  nominalSize?: string | null;
  diameterM?: number | null;
  widthM?: number | null;
}): string | null {
  const text = input.nominalSize?.trim();
  if (text) return text;
  if (typeof input.diameterM === "number" && Number.isFinite(input.diameterM) && input.diameterM > 0)
    return `Ø${mm(input.diameterM)} mm`;
  if (typeof input.widthM === "number" && Number.isFinite(input.widthM) && input.widthM > 0)
    return `W${mm(input.widthM)} mm`;
  return null;
}

/** The numeric size a stored text carries, if any. Unrecognised text yields `{}`, never a guess. */
export function parseNominalSize(nominalSize: string | null | undefined): NumericSize {
  if (!nominalSize) return {};
  const text = nominalSize.trim();
  const diameter = DIAMETER_RE.exec(text);
  if (diameter?.[1]) return { diameterM: Number(diameter[1]) / 1000 };
  const width = WIDTH_RE.exec(text);
  if (width?.[1]) return { widthM: Number(width[1]) / 1000 };
  return {};
}
