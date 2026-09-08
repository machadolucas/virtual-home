/**
 * What a piece of equipment looks like in the model.
 *
 * A single 6 cm sphere for everything meant the 3D view could not answer "which of those is the
 * lamp post and which is the ceiling light" — the one question a picture is supposed to answer.
 * So each symbol is a small, recognisable silhouette instead: a hanging dome, a wall bracket, a
 * standing lamp, a post, a ground spike, a downlight, a vent grille.
 *
 * Deliberately **procedural**, not modelled assets. Three reasons: the model package is immutable
 * input and household symbols are not part of it; a GLB per fixture type would be megabytes of
 * download for shapes that read at 30 px on screen; and each symbol has to merge into *one*
 * `BufferGeometry` so the marker layer can keep drawing a whole floor's equipment in one
 * instanced call per symbol.
 *
 * Every symbol is authored around its **mount point at the origin**, with +Y up, so the same
 * placement coordinate reads correctly whether the thing hangs from a ceiling (dome below the
 * origin), sits on a floor (body above it) or bolts to a wall.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const PLACEMENT_SYMBOLS = [
  "generic",
  "ceiling_lamp",
  "wall_lamp",
  "floor_lamp",
  "lamp_post",
  "spike_spot",
  "downlight",
  "vent",
  "sensor",
  "socket",
  "valve",
  "radiator",
] as const;

export type PlacementSymbol = (typeof PLACEMENT_SYMBOLS)[number];

export const SYMBOL_LABEL: { readonly [S in PlacementSymbol]: string } = {
  generic: "Generic marker",
  ceiling_lamp: "Ceiling lamp",
  wall_lamp: "Wall lamp",
  floor_lamp: "Floor lamp",
  lamp_post: "Lamp post",
  spike_spot: "Ground spike spot",
  downlight: "Downlight / eave spot",
  vent: "Air vent",
  sensor: "Sensor",
  socket: "Socket / outlet",
  valve: "Valve / shutoff",
  radiator: "Radiator",
};

/** Low segment counts on purpose: these are 20–40 px silhouettes, not hero assets. */
const RADIAL = 10;

function translated(geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
  geometry.translate(x, y, z);
  return geometry;
}

function rotatedX(geometry: THREE.BufferGeometry, radians: number) {
  geometry.rotateX(radians);
  return geometry;
}

/**
 * One geometry per symbol, merged from primitives. Built once, lazily, and shared by every
 * instanced mesh — a symbol's geometry is identical for all 200 markers that use it.
 */
function build(symbol: PlacementSymbol): THREE.BufferGeometry {
  switch (symbol) {
    case "ceiling_lamp":
      // Flush base at the origin, a short drop, then the dome hanging below it.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.03, 0.03, 0.02, RADIAL), 0, -0.01, 0),
        translated(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 6), 0, -0.06, 0),
        translated(new THREE.ConeGeometry(0.075, 0.07, RADIAL, 1, true), 0, -0.135, 0),
      ])!;

    case "wall_lamp":
      // A back plate on the wall face, a short arm out, and a small shade.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.06, 0.08, 0.015), 0, 0, 0.008),
        translated(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6), 0, 0.02, 0.05),
        translated(
          rotatedX(new THREE.ConeGeometry(0.05, 0.06, RADIAL, 1, true), Math.PI),
          0,
          0.055,
          0.085,
        ),
      ])!;

    case "floor_lamp":
      // Stands on the placement point: weighted foot, pole, shade at head height (scaled down —
      // a true 1.6 m lamp would dwarf every other marker).
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.055, 0.065, 0.015, RADIAL), 0, 0.008, 0),
        translated(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6), 0, 0.16, 0),
        translated(new THREE.ConeGeometry(0.07, 0.09, RADIAL, 1, true), 0, 0.35, 0),
      ])!;

    case "lamp_post":
      // Taller and thicker than a floor lamp, with a head that overhangs — the outdoor silhouette.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.045, 0.06, 0.03, RADIAL), 0, 0.015, 0),
        translated(new THREE.CylinderGeometry(0.014, 0.018, 0.55, 8), 0, 0.3, 0),
        translated(new THREE.BoxGeometry(0.02, 0.02, 0.1), 0, 0.575, 0.045),
        translated(new THREE.ConeGeometry(0.055, 0.05, RADIAL, 1, true), 0, 0.555, 0.09),
      ])!;

    case "spike_spot":
      // Ground spike below the origin, small barrel above it, aimed up.
      return mergeGeometries([
        translated(new THREE.ConeGeometry(0.016, 0.09, 6), 0, -0.045, 0),
        translated(new THREE.CylinderGeometry(0.03, 0.03, 0.075, RADIAL), 0, 0.04, 0),
        translated(new THREE.CylinderGeometry(0.034, 0.034, 0.008, RADIAL), 0, 0.081, 0),
      ])!;

    case "downlight":
      // The eave/soffit case: a trim ring flush with the surface and a short barrel below it.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.045, 0.045, 0.008, RADIAL), 0, -0.004, 0),
        translated(new THREE.CylinderGeometry(0.032, 0.036, 0.05, RADIAL), 0, -0.033, 0),
      ])!;

    case "vent":
      // A grille: flat plate plus three louvre bars, so it reads as a vent and not as a box.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.13, 0.012, 0.09), 0, -0.006, 0),
        translated(new THREE.BoxGeometry(0.11, 0.008, 0.012), 0, -0.016, -0.025),
        translated(new THREE.BoxGeometry(0.11, 0.008, 0.012), 0, -0.016, 0),
        translated(new THREE.BoxGeometry(0.11, 0.008, 0.012), 0, -0.016, 0.025),
      ])!;

    case "sensor":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.055, 0.075, 0.025), 0, 0.038, 0),
        translated(new THREE.SphereGeometry(0.012, 8, 6), 0, 0.062, 0.016),
      ])!;

    case "socket":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.07, 0.07, 0.02), 0, 0.035, 0.01),
        translated(new THREE.CylinderGeometry(0.022, 0.022, 0.006, RADIAL), 0, 0.035, 0.023),
      ])!;

    case "valve":
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), 0, 0.025, 0),
        translated(new THREE.TorusGeometry(0.035, 0.008, 6, 12), 0, 0.055, 0),
      ])!;

    case "radiator":
      // A slab with fins, low and wide.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.22, 0.12, 0.03), 0, 0.06, 0),
        translated(new THREE.BoxGeometry(0.22, 0.012, 0.05), 0, 0.115, 0),
      ])!;

    case "generic":
    default:
      // What every marker used to be. Kept as the honest default for anything unclassified.
      return new THREE.SphereGeometry(0.06, 10, 8);
  }
}

const cache = new Map<PlacementSymbol, THREE.BufferGeometry>();

export function symbolGeometry(symbol: PlacementSymbol): THREE.BufferGeometry {
  let geometry = cache.get(symbol);
  if (!geometry) {
    geometry = build(symbol);
    geometry.computeBoundingSphere();
    cache.set(symbol, geometry);
  }
  return geometry;
}

/** Frees the shared geometries. Only for teardown in tests; the app keeps them for its lifetime. */
export function disposeSymbolGeometries(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}

export function isPlacementSymbol(value: unknown): value is PlacementSymbol {
  return typeof value === "string" && (PLACEMENT_SYMBOLS as readonly string[]).includes(value);
}

/**
 * The symbol to draw when nobody has chosen one.
 *
 * A guess about *appearance* only — it never writes anything to the database, so a wrong guess
 * costs a glance, not a fact. Mount kind is the strongest signal (a light on a ceiling is a
 * ceiling lamp; on a wall, a bracket), with the category breaking ties and outdoor placements
 * defaulting to the post-and-spike family.
 */
export function defaultSymbol(input: {
  category?: string | null;
  mountKind?: string | null;
  isOutdoor?: boolean;
}): PlacementSymbol {
  const category = input.category ?? "";
  const mount = input.mountKind ?? "floor";

  if (category === "hvac") return "vent";
  if (category === "plumbing") return "valve";

  if (category === "electrical" || category === "outdoor") {
    if (mount === "ceiling") return input.isOutdoor ? "downlight" : "ceiling_lamp";
    if (mount === "wall") return "wall_lamp";
    if (input.isOutdoor) return mount === "free" ? "spike_spot" : "lamp_post";
    return category === "electrical" ? "socket" : "floor_lamp";
  }

  if (category === "safety" || category === "network") return "sensor";
  return "generic";
}
