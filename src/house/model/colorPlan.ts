/**
 * Pure colour planning. A plan is a list of `(surfaceId, hex)` decisions; nothing here touches
 * three.js, so "colour never leaks between rooms" is provable as a data property in a unit test.
 */
import { ROOM_SURFACE_KINDS } from "./manifestIndex";
import type { Room, Surface, SurfaceId, SurfaceKind } from "./types";

export interface ColorDecision {
  surfaceId: SurfaceId;
  hex: string;
  source: "override" | "default";
}

export type NodeColorPlan = ReadonlyArray<ColorDecision>;

/** Lower-cases and validates a `#rrggbb` string; `#RGB` shorthand is expanded. */
export function normalizeHex(raw: string): string {
  const s = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(s)) throw new Error(`not a #rrggbb colour: ${raw}`);
  return s;
}

export function isHex(raw: string): boolean {
  try {
    normalizeHex(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Colour plan for one room.
 *
 * Two guards matter:
 *  - `kinds` filters by surface **kind** only. Excluding by `role` would wrongly skip
 *    `dormer-front-wall` and `dormer-ceiling`, which are real room faces.
 *  - `s.roomId !== room.id` is defensive: `room.surfaceIds` is authored data, and if a future
 *    revision listed a neighbour's face here we must not repaint it (the mismatch shows up as a
 *    `W_ORPHAN_SURFACE` diagnostic instead of a visible colour bleed).
 */
export function planRoomColors(
  room: Room,
  surfacesById: ReadonlyMap<SurfaceId, Surface>,
  overrides: Readonly<Record<SurfaceId, string>>,
  opts: { kinds?: ReadonlySet<SurfaceKind> } = {},
): NodeColorPlan {
  const kinds = opts.kinds ?? ROOM_SURFACE_KINDS;
  const out: ColorDecision[] = [];
  for (const sid of room.surfaceIds) {
    const s = surfacesById.get(sid);
    if (!s) continue; // manifest inconsistency — reported by crossCheck, not repainted here
    if (s.roomId !== room.id) continue;
    if (!kinds.has(s.kind)) continue;
    out.push(decide(s, overrides));
  }
  return out;
}

/** Whole-model plan: every surface, override or default. Used at load and on reset. */
export function planAllSurfaces(
  surfaces: readonly Surface[],
  overrides: Readonly<Record<SurfaceId, string>>,
): NodeColorPlan {
  return surfaces.map((s) => decide(s, overrides));
}

/** Reset plan: the manifest's `defaultColor`, never whatever happened to load. */
export function planResetRoom(
  room: Room,
  surfacesById: ReadonlyMap<SurfaceId, Surface>,
  opts: { kinds?: ReadonlySet<SurfaceKind> } = {},
): NodeColorPlan {
  return planRoomColors(room, surfacesById, {}, opts);
}

function decide(s: Surface, overrides: Readonly<Record<SurfaceId, string>>): ColorDecision {
  const ov = overrides[s.id];
  if (ov && isHex(ov)) return { surfaceId: s.id, hex: normalizeHex(ov), source: "override" };
  return { surfaceId: s.id, hex: normalizeHex(s.defaultColor), source: "default" };
}

/** sRGB hex → 0..1 linear triple. Mirrors glTF's `baseColorFactor` encoding. */
export function hexToLinear(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  const chan = (i: number) => {
    const v = parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [chan(0), chan(1), chan(2)];
}

/** 0..1 linear triple → sRGB hex. The invariant `hexFromLinear(baseColorFactor) === defaultColor`
 * holds for all 403 mesh-backed surfaces of the shipped package and is asserted in a unit test. */
export function hexFromLinear(rgb: readonly number[]): string {
  const enc = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    const b = Math.round(Math.max(0, Math.min(1, c)) * 255);
    return b.toString(16).padStart(2, "0");
  };
  return `#${enc(rgb[0] ?? 0)}${enc(rgb[1] ?? 0)}${enc(rgb[2] ?? 0)}`;
}
