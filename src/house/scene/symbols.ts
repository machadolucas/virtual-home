/**
 * What a piece of equipment looks like in the model.
 *
 * A single 6 cm sphere for everything meant the 3D view could not answer "which of those is the
 * lamp post and which is the ceiling light" — the one question a picture is supposed to answer.
 * So each symbol is a lightweight, recognisable silhouette instead: a hanging dome, a wall bracket, a
 * standing lamp, a lantern post, adjustable spots, appliances and building services.
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
import { PHYSICAL_SYMBOL_SIZE } from "../model/equipmentDimensions";

export const PLACEMENT_SYMBOLS = [
  "generic",
  "ceiling_lamp",
  "wall_lamp",
  "floor_lamp",
  "lamp_post",
  "wall_spot",
  "floor_spot",
  "ceiling_spot",
  "spike_spot",
  "downlight",
  "vent",
  "sensor",
  "motion_sensor",
  "wifi_access_point",
  "robot_vacuum",
  "heat_pump_indoor",
  "heat_pump_outdoor",
  "homepod",
  "network_switch",
  "security_camera",
  "fan",
  "humidifier",
  "led_bar_vertical",
  "led_bar_horizontal",
  "socket",
  "switch",
  "remote_control",
  "valve",
  "radiator",
  "floor_heating",
  "dishwasher",
  "fridge",
  "freezer",
  "washing_machine",
  "dryer",
  "water_tap",
  "shower",
  "toilet",
  "sink",
  "sauna_heater_electric",
  "sauna_heater_wood",
  "tv",
  "server_rack",
  "router",
  "nvr",
  "nas",
  "media_player",
  "solar_panel",
  "tree",
] as const;

export type PlacementSymbol = (typeof PLACEMENT_SYMBOLS)[number];

export const SYMBOL_LABEL: { readonly [S in PlacementSymbol]: string } = {
  generic: "Generic marker",
  ceiling_lamp: "Ceiling lamp",
  wall_lamp: "Wall lamp",
  floor_lamp: "Floor lamp",
  lamp_post: "Lantern post",
  wall_spot: "Wall spot",
  floor_spot: "Floor spot",
  ceiling_spot: "Ceiling spot",
  spike_spot: "Ground spike spot",
  downlight: "Downlight / eave spot",
  vent: "Air vent",
  sensor: "Sensor",
  motion_sensor: "Motion sensor",
  wifi_access_point: "Wi-Fi access point",
  robot_vacuum: "Robot vacuum",
  heat_pump_indoor: "Heat pump (indoor)",
  heat_pump_outdoor: "Heat pump (outdoor)",
  homepod: "HomePod",
  network_switch: "Network switch",
  security_camera: "Security camera",
  fan: "Fan",
  humidifier: "Humidifier",
  led_bar_vertical: "LED bar (vertical)",
  led_bar_horizontal: "LED bar (horizontal)",
  socket: "Socket / outlet",
  switch: "Switch / Hue remote",
  remote_control: "Remote control",
  valve: "Valve / shutoff",
  radiator: "Radiator",
  floor_heating: "Floor heating",
  dishwasher: "Dishwasher",
  fridge: "Fridge",
  freezer: "Freezer",
  washing_machine: "Washing machine",
  dryer: "Dryer",
  water_tap: "Water tap",
  shower: "Shower",
  toilet: "Toilet",
  sink: "Sink",
  sauna_heater_electric: "Sauna heater — electric",
  sauna_heater_wood: "Sauna heater — wood-fired",
  tv: "TV",
  server_rack: "Server rack",
  router: "Router",
  nvr: "NVR",
  nas: "NAS",
  media_player: "Media player",
  solar_panel: "Solar panel",
  tree: "Tree",
};

/** Low segment counts on purpose: these are context geometry, not hero assets. */
const RADIAL = 10;

function translated(geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
  geometry.translate(x, y, z);
  return geometry;
}

function rotatedX(geometry: THREE.BufferGeometry, radians: number) {
  geometry.rotateX(radians);
  return geometry;
}

function rotatedZ(geometry: THREE.BufferGeometry, radians: number) {
  geometry.rotateZ(radians);
  return geometry;
}

function scaled(geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
  geometry.scale(x, y, z);
  return geometry;
}

function tinted(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const count = geometry.getAttribute("position").count;
  const tint = new THREE.Color(color);
  const values = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) tint.toArray(values, index * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(values, 3));
  return geometry;
}

/**
 * One geometry per symbol, merged from primitives. Built once, lazily, and shared by every
 * instanced mesh — a symbol's geometry is identical for all 200 markers that use it.
 */
function buildRaw(symbol: PlacementSymbol): THREE.BufferGeometry {
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
      // A single straight pole with a centred lantern sitting directly on top. There is no arm or
      // hanging fixture: the symmetry is intentional and keeps it distinct from a street light.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.045, 0.06, 0.03, RADIAL), 0, 0.015, 0),
        translated(new THREE.CylinderGeometry(0.014, 0.018, 0.5, 8), 0, 0.28, 0),
        translated(new THREE.BoxGeometry(0.08, 0.012, 0.08), 0, 0.536, 0),
        translated(new THREE.BoxGeometry(0.064, 0.09, 0.064), 0, 0.587, 0),
        translated(new THREE.ConeGeometry(0.06, 0.055, 4), 0, 0.66, 0),
      ])!;

    case "wall_spot":
      // Wall plate, articulated knuckle and a short barrel pointing away from the wall (+Z).
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.075, 0.075, 0.014), 0, 0.02, 0.007),
        translated(rotatedX(new THREE.CylinderGeometry(0.01, 0.01, 0.04, 7), Math.PI / 2), 0, 0.02, 0.035),
        translated(rotatedX(new THREE.CylinderGeometry(0.034, 0.026, 0.07, RADIAL), Math.PI / 2), 0, 0.045, 0.078),
        translated(new THREE.SphereGeometry(0.014, 7, 5), 0, 0.02, 0.052),
      ])!;

    case "floor_spot":
      // A weighted standing lamp with an adjustable spotlight barrel at the top.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.055, 0.065, 0.015, RADIAL), 0, 0.008, 0),
        translated(new THREE.CylinderGeometry(0.008, 0.008, 0.31, 6), 0, 0.165, 0),
        translated(new THREE.SphereGeometry(0.017, 7, 5), 0, 0.326, 0),
        translated(rotatedX(new THREE.CylinderGeometry(0.038, 0.028, 0.075, RADIAL), Math.PI / 2), 0, 0.35, 0.035),
      ])!;

    case "ceiling_spot":
      // Flush plate below the mount, a small joint, and an angled adjustable barrel.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.05, 0.05, 0.012, RADIAL), 0, -0.006, 0),
        translated(new THREE.CylinderGeometry(0.008, 0.008, 0.04, 7), 0, -0.03, 0),
        translated(new THREE.SphereGeometry(0.016, 7, 5), 0, -0.052, 0),
        translated(rotatedZ(new THREE.CylinderGeometry(0.027, 0.036, 0.075, RADIAL), -Math.PI / 5), 0.024, -0.088, 0),
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

    case "motion_sensor":
      // Wall casing with a large faceted PIR lens facing +Z, the shared aiming direction.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.065, 0.085, 0.028), 0, 0.043, 0.014),
        translated(scaled(new THREE.SphereGeometry(0.032, 10, 6), 1, 0.72, 0.55), 0, 0.057, 0.038),
      ])!;

    case "wifi_access_point":
      // A shallow ceiling puck with two raised radio-wave arcs.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.072, 0.072, 0.022, 14), 0, -0.011, 0),
        translated(rotatedX(new THREE.TorusGeometry(0.024, 0.004, 5, 10, Math.PI), Math.PI / 2), 0, -0.025, 0.006),
        translated(rotatedX(new THREE.TorusGeometry(0.043, 0.004, 5, 12, Math.PI), Math.PI / 2), 0, -0.027, 0.006),
      ])!;

    case "robot_vacuum":
      // Low circular chassis, front bumper and the small lidar turret seen on robot vacuums.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.105, 0.105, 0.045, 16), 0, 0.023, 0),
        translated(new THREE.BoxGeometry(0.15, 0.032, 0.025), 0, 0.025, 0.1),
        translated(new THREE.CylinderGeometry(0.027, 0.027, 0.025, 10), -0.035, 0.058, -0.015),
        translated(new THREE.CylinderGeometry(0.012, 0.012, 0.008, 8), 0.055, 0.05, 0.075),
      ])!;

    case "heat_pump_indoor": {
      // Wall-mounted indoor cassette with a lower outlet and three directional vanes.
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(0.32, 0.115, 0.075), 0, 0.058, 0.038),
        translated(new THREE.BoxGeometry(0.28, 0.025, 0.02), 0, 0.013, 0.082),
      ];
      for (const x of [-0.09, 0, 0.09]) {
        parts.push(translated(rotatedZ(new THREE.BoxGeometry(0.008, 0.035, 0.018), -0.2), x, 0.014, 0.098));
      }
      return mergeGeometries(parts)!;
    }

    case "heat_pump_outdoor": {
      // Outdoor condenser cabinet, feet and a prominent front fan grille.
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(0.29, 0.23, 0.14), 0, 0.135, 0),
        translated(new THREE.BoxGeometry(0.09, 0.02, 0.17), -0.085, 0.01, 0),
        translated(new THREE.BoxGeometry(0.09, 0.02, 0.17), 0.085, 0.01, 0),
        translated(rotatedX(new THREE.TorusGeometry(0.075, 0.008, 6, 16), Math.PI / 2), 0.04, 0.145, 0.078),
        translated(rotatedX(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 8), Math.PI / 2), 0.04, 0.145, 0.085),
      ];
      for (let blade = 0; blade < 4; blade += 1) {
        parts.push(
          translated(
            rotatedZ(new THREE.BoxGeometry(0.018, 0.064, 0.008), blade * Math.PI / 2 + 0.45),
            0.04,
            0.145,
            0.086,
          ),
        );
      }
      return mergeGeometries(parts)!;
    }

    case "homepod":
      // A compact fabric-speaker capsule with distinct top and bottom caps.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.062, 0.068, 0.115, 14), 0, 0.068, 0),
        translated(scaled(new THREE.SphereGeometry(0.064, 14, 6), 1, 0.25, 1), 0, 0.126, 0),
        translated(new THREE.CylinderGeometry(0.045, 0.045, 0.006, 14), 0, 0.139, 0),
        translated(new THREE.CylinderGeometry(0.057, 0.057, 0.008, 14), 0, 0.004, 0),
      ])!;

    case "network_switch": {
      // Shallow rack-style switch with a row of eight visible Ethernet sockets.
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(0.28, 0.055, 0.15), 0, 0.028, 0),
      ];
      for (let port = 0; port < 8; port += 1) {
        parts.push(
          translated(new THREE.BoxGeometry(0.024, 0.018, 0.009), -0.105 + port * 0.03, 0.031, 0.079),
        );
      }
      return mergeGeometries(parts)!;
    }

    case "security_camera":
      // Wall plate and elbow bracket supporting a bullet camera aimed along +Z.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.075, 0.085, 0.016), 0, 0.043, 0.008),
        translated(rotatedX(new THREE.CylinderGeometry(0.01, 0.01, 0.07, 7), Math.PI / 2), 0, 0.048, 0.045),
        translated(new THREE.SphereGeometry(0.018, 8, 5), 0, 0.048, 0.078),
        translated(rotatedX(new THREE.CylinderGeometry(0.041, 0.033, 0.12, 12), Math.PI / 2), 0, 0.07, 0.13),
        translated(rotatedX(new THREE.CylinderGeometry(0.035, 0.035, 0.012, 12), Math.PI / 2), 0, 0.07, 0.194),
        translated(rotatedX(new THREE.CylinderGeometry(0.014, 0.014, 0.014, 9), Math.PI / 2), 0, 0.07, 0.202),
      ])!;

    case "fan": {
      // Pedestal fan with a ring guard, hub and three broad blades facing +Z.
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.CylinderGeometry(0.07, 0.085, 0.018, 12), 0, 0.009, 0),
        translated(new THREE.CylinderGeometry(0.01, 0.01, 0.18, 7), 0, 0.108, 0),
        translated(rotatedX(new THREE.TorusGeometry(0.09, 0.008, 6, 18), Math.PI / 2), 0, 0.245, 0),
        translated(rotatedX(new THREE.CylinderGeometry(0.018, 0.018, 0.025, 9), Math.PI / 2), 0, 0.245, 0),
      ];
      for (let blade = 0; blade < 3; blade += 1) {
        parts.push(
          translated(
            rotatedZ(new THREE.BoxGeometry(0.025, 0.07, 0.009), blade * ((Math.PI * 2) / 3) + 0.4),
            0,
            0.245,
            0.014,
          ),
        );
      }
      return mergeGeometries(parts)!;
    }

    case "humidifier":
      // Floor unit with a translucent-tank silhouette, cap and offset mist nozzle.
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.07, 0.082, 0.15, 12), 0, 0.075, 0),
        translated(new THREE.CylinderGeometry(0.058, 0.066, 0.09, 12), 0, 0.195, 0),
        translated(new THREE.CylinderGeometry(0.064, 0.064, 0.014, 12), 0, 0.247, 0),
        translated(new THREE.CylinderGeometry(0.013, 0.017, 0.034, 8), 0.028, 0.271, 0),
        translated(scaled(new THREE.SphereGeometry(0.012, 8, 5), 0.7, 1.25, 0.7), 0.028, 0.302, 0),
      ])!;

    case "led_bar_vertical":
      // Unit length on +Y, anchored at y=0. The placement scales Y to the configured length.
      return new THREE.BoxGeometry(0.03, 1, 0.025, 1, 2, 1).translate(0, 0.5, 0);

    case "led_bar_horizontal":
      // Unit length on X, centred at x=0. The placement scales X to the configured length.
      return new THREE.BoxGeometry(1, 0.03, 0.025);

    case "socket":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.07, 0.07, 0.02), 0, 0.035, 0.01),
        translated(new THREE.CylinderGeometry(0.022, 0.022, 0.006, RADIAL), 0, 0.035, 0.023),
      ])!;

    case "switch":
      // Compact wall remote: a thin rounded-looking body and four tactile buttons.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.052, 0.09, 0.014), 0, 0.045, 0.007),
        translated(rotatedX(new THREE.CylinderGeometry(0.012, 0.012, 0.005, 10), Math.PI / 2), -0.013, 0.064, 0.017),
        translated(rotatedX(new THREE.CylinderGeometry(0.012, 0.012, 0.005, 10), Math.PI / 2), 0.013, 0.064, 0.017),
        translated(rotatedX(new THREE.CylinderGeometry(0.012, 0.012, 0.005, 10), Math.PI / 2), -0.013, 0.031, 0.017),
        translated(rotatedX(new THREE.CylinderGeometry(0.012, 0.012, 0.005, 10), Math.PI / 2), 0.013, 0.031, 0.017),
      ])!;

    case "remote_control":
      // Hand-held remote laid on its back, with a large navigation disc and two small buttons.
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.06, 0.16, 0.018), 0, 0.08, 0.009),
        translated(rotatedX(new THREE.CylinderGeometry(0.022, 0.022, 0.006, 12), Math.PI / 2), 0, 0.115, 0.021),
        translated(new THREE.SphereGeometry(0.009, 8, 5), 0, 0.068, 0.021),
        translated(new THREE.SphereGeometry(0.007, 8, 5), 0, 0.043, 0.021),
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

    case "floor_heating": {
      // A square serpentine coil just above the floor, joined into one continuous visual run.
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(0.25, 0.008, 0.25), 0, 0.004, 0),
      ];
      for (let row = 0; row < 6; row += 1) {
        const z = -0.09 + row * 0.036;
        parts.push(translated(new THREE.BoxGeometry(0.19, 0.009, 0.008), 0, 0.013, z));
        if (row < 5) {
          const x = row % 2 === 0 ? 0.091 : -0.091;
          parts.push(translated(new THREE.BoxGeometry(0.008, 0.009, 0.044), x, 0.013, z + 0.018));
        }
      }
      return mergeGeometries(parts)!;
    }

    case "dishwasher":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.2, 0.25, 0.17), 0, 0.125, 0),
        translated(new THREE.BoxGeometry(0.16, 0.012, 0.012), 0, 0.218, 0.092),
        translated(new THREE.BoxGeometry(0.15, 0.015, 0.008), 0, 0.19, 0.091),
      ])!;

    case "fridge":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.19, 0.38, 0.17), 0, 0.19, 0),
        translated(new THREE.BoxGeometry(0.175, 0.009, 0.012), 0, 0.15, 0.091),
        translated(new THREE.BoxGeometry(0.012, 0.09, 0.012), 0.066, 0.242, 0.091),
        translated(new THREE.BoxGeometry(0.012, 0.06, 0.012), 0.066, 0.11, 0.091),
      ])!;

    case "freezer":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.19, 0.38, 0.17), 0, 0.19, 0),
        translated(new THREE.BoxGeometry(0.175, 0.009, 0.012), 0, 0.29, 0.091),
        translated(new THREE.BoxGeometry(0.175, 0.009, 0.012), 0, 0.2, 0.091),
        translated(new THREE.BoxGeometry(0.175, 0.009, 0.012), 0, 0.11, 0.091),
        translated(new THREE.BoxGeometry(0.012, 0.16, 0.012), 0.066, 0.21, 0.091),
      ])!;

    case "washing_machine":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.2, 0.26, 0.18), 0, 0.13, 0),
        translated(new THREE.TorusGeometry(0.055, 0.012, 7, 14), 0, 0.125, 0.098),
        translated(new THREE.CylinderGeometry(0.043, 0.043, 0.012, 14), 0, 0.125, 0.098),
        translated(new THREE.BoxGeometry(0.12, 0.025, 0.01), -0.018, 0.225, 0.096),
      ])!;

    case "dryer":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.2, 0.27, 0.18), 0, 0.135, 0),
        translated(new THREE.TorusGeometry(0.062, 0.009, 7, 16), 0, 0.13, 0.098),
        translated(new THREE.CylinderGeometry(0.049, 0.049, 0.009, 16), 0, 0.13, 0.098),
        translated(new THREE.BoxGeometry(0.05, 0.018, 0.01), 0.05, 0.235, 0.096),
        translated(new THREE.SphereGeometry(0.008, 7, 5), -0.06, 0.235, 0.102),
      ])!;

    case "water_tap":
      return mergeGeometries([
        translated(new THREE.CylinderGeometry(0.014, 0.014, 0.12, 8), -0.045, 0.06, 0),
        translated(new THREE.TorusGeometry(0.045, 0.014, 7, 12, Math.PI), 0, 0.12, 0),
        translated(new THREE.CylinderGeometry(0.013, 0.013, 0.065, 8), 0.045, 0.09, 0),
        translated(rotatedZ(new THREE.CylinderGeometry(0.009, 0.009, 0.065, 7), Math.PI / 2), -0.045, 0.115, 0),
      ])!;

    case "shower":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.07, 0.08, 0.014), 0, 0.04, 0.007),
        translated(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 7), 0, 0.18, 0.025),
        translated(rotatedZ(new THREE.CylinderGeometry(0.008, 0.008, 0.075, 7), Math.PI / 2), 0.035, 0.296, 0.025),
        translated(rotatedX(new THREE.CylinderGeometry(0.045, 0.03, 0.025, RADIAL), Math.PI / 2), 0.073, 0.296, 0.038),
      ])!;

    case "toilet":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.13, 0.18, 0.07), 0, 0.15, -0.055),
        translated(scaled(new THREE.SphereGeometry(0.09, 12, 8), 1, 0.52, 1.25), 0, 0.105, 0.045),
        translated(rotatedX(new THREE.TorusGeometry(0.066, 0.012, 7, 14), Math.PI / 2), 0, 0.132, 0.055),
        translated(new THREE.CylinderGeometry(0.045, 0.065, 0.08, 10), 0, 0.04, 0.015),
      ])!;

    case "sink":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.24, 0.035, 0.17), 0, 0.1, 0),
        translated(scaled(new THREE.SphereGeometry(0.08, 12, 7), 1.25, 0.3, 0.8), 0, 0.08, 0.015),
        translated(new THREE.CylinderGeometry(0.009, 0.009, 0.095, 7), -0.065, 0.16, -0.045),
        translated(new THREE.TorusGeometry(0.035, 0.009, 6, 10, Math.PI), -0.03, 0.205, -0.045),
      ])!;

    case "sauna_heater_electric": {
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(0.17, 0.19, 0.15), 0, 0.095, 0),
        translated(scaled(new THREE.SphereGeometry(0.035, 7, 5), 1.2, 0.7, 1), -0.045, 0.205, 0),
        translated(scaled(new THREE.SphereGeometry(0.035, 7, 5), 1.1, 0.8, 1), 0.035, 0.205, 0.015),
      ];
      for (const x of [-0.065, -0.022, 0.022, 0.065]) {
        parts.push(translated(new THREE.BoxGeometry(0.008, 0.17, 0.16), x, 0.105, 0));
      }
      return mergeGeometries(parts)!;
    }

    case "sauna_heater_wood":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.18, 0.21, 0.17), 0, 0.105, 0),
        translated(new THREE.BoxGeometry(0.115, 0.1, 0.012), 0, 0.095, 0.091),
        translated(new THREE.TorusGeometry(0.027, 0.007, 6, 12), 0, 0.097, 0.099),
        translated(new THREE.CylinderGeometry(0.032, 0.032, 0.18, 9), 0.04, 0.3, -0.035),
        translated(scaled(new THREE.SphereGeometry(0.034, 7, 5), 1.2, 0.65, 1), -0.04, 0.225, 0),
      ])!;

    case "tv":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.34, 0.2, 0.025), 0, 0.2, 0),
        translated(new THREE.BoxGeometry(0.3, 0.16, 0.01), 0, 0.2, 0.018),
        translated(new THREE.BoxGeometry(0.018, 0.09, 0.018), 0, 0.065, 0),
        translated(new THREE.BoxGeometry(0.16, 0.015, 0.08), 0, 0.012, 0),
      ])!;

    case "server_rack": {
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(0.23, 0.38, 0.19), 0, 0.19, 0),
        translated(new THREE.BoxGeometry(0.19, 0.34, 0.012), 0, 0.19, 0.101),
      ];
      for (const y of [0.08, 0.14, 0.2, 0.26, 0.32]) {
        parts.push(translated(new THREE.BoxGeometry(0.165, 0.025, 0.01), 0, y, 0.109));
      }
      return mergeGeometries(parts)!;
    }

    case "router":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.22, 0.045, 0.14), 0, 0.023, 0),
        translated(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 6), -0.082, 0.105, -0.055),
        translated(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 6), 0.082, 0.105, -0.055),
        translated(new THREE.SphereGeometry(0.007, 7, 5), -0.055, 0.038, 0.074),
        translated(new THREE.SphereGeometry(0.007, 7, 5), -0.03, 0.038, 0.074),
        translated(new THREE.SphereGeometry(0.007, 7, 5), -0.005, 0.038, 0.074),
      ])!;

    case "nvr":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.25, 0.075, 0.19), 0, 0.038, 0),
        translated(new THREE.BoxGeometry(0.11, 0.036, 0.008), -0.045, 0.042, 0.099),
        translated(new THREE.CylinderGeometry(0.009, 0.009, 0.008, 8), 0.09, 0.042, 0.099),
      ])!;

    case "nas":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.16, 0.22, 0.18), 0, 0.11, 0),
        translated(new THREE.BoxGeometry(0.052, 0.15, 0.012), -0.034, 0.12, 0.096),
        translated(new THREE.BoxGeometry(0.052, 0.15, 0.012), 0.034, 0.12, 0.096),
        translated(new THREE.SphereGeometry(0.007, 7, 5), -0.052, 0.034, 0.103),
        translated(new THREE.SphereGeometry(0.007, 7, 5), -0.028, 0.034, 0.103),
      ])!;

    case "media_player":
      return mergeGeometries([
        translated(new THREE.BoxGeometry(0.16, 0.035, 0.16), 0, 0.018, 0),
        translated(new THREE.CylinderGeometry(0.018, 0.018, 0.006, 12), 0, 0.039, 0),
        translated(new THREE.SphereGeometry(0.006, 7, 5), 0.055, 0.034, 0.083),
      ])!;

    case "solar_panel": {
      // Normalized x/y/z extents are exactly 1 × 1 × 1, with the bottom on y=0. The placement
      // layer can therefore scale width, physical thickness and length independently.
      const parts: THREE.BufferGeometry[] = [
        translated(new THREE.BoxGeometry(1, 0.72, 1), 0, 0.36, 0),
        translated(new THREE.BoxGeometry(1, 0.28, 0.035), 0, 0.86, -0.4825),
        translated(new THREE.BoxGeometry(1, 0.28, 0.035), 0, 0.86, 0.4825),
        translated(new THREE.BoxGeometry(0.035, 0.28, 0.93), -0.4825, 0.86, 0),
        translated(new THREE.BoxGeometry(0.035, 0.28, 0.93), 0.4825, 0.86, 0),
      ];
      for (const x of [-0.25, 0, 0.25]) {
        parts.push(translated(new THREE.BoxGeometry(0.015, 0.06, 0.93), x, 0.75, 0));
      }
      for (const z of [-0.25, 0, 0.25]) {
        parts.push(translated(new THREE.BoxGeometry(0.93, 0.06, 0.015), 0, 0.75, z));
      }
      return mergeGeometries(parts)!;
    }

    case "tree":
      // A five-metre deciduous tree: tapered trunk, a few visible branches and an irregular,
      // layered crown. The placement layer scales the whole silhouette to the saved height, so
      // a young fruit tree stays slender while a mature yard tree gains an appropriate canopy.
      return mergeGeometries([
        tinted(translated(new THREE.CylinderGeometry(0.18, 0.28, 2.65, 9), 0, 1.325, 0), 0x70513b),
        tinted(translated(rotatedZ(new THREE.CylinderGeometry(0.07, 0.12, 1.25, 7), -0.7), -0.38, 2.65, 0.04), 0x70513b),
        tinted(translated(rotatedZ(new THREE.CylinderGeometry(0.06, 0.1, 1.15, 7), 0.75), 0.4, 2.75, -0.08), 0x70513b),
        tinted(translated(rotatedX(new THREE.CylinderGeometry(0.055, 0.09, 1.05, 7), 0.7), 0.02, 2.7, 0.38), 0x70513b),
        tinted(translated(scaled(new THREE.SphereGeometry(1, 8, 5), 1.35, 1.1, 1.2), -0.45, 3.75, 0), 0x477443),
        tinted(translated(scaled(new THREE.SphereGeometry(1, 8, 5), 1.28, 1.05, 1.25), 0.55, 3.85, -0.12), 0x527f48),
        tinted(translated(scaled(new THREE.SphereGeometry(1, 8, 5), 1.18, 1.0, 1.12), 0.05, 4.45, 0.25), 0x5d8b4f),
      ])!;

    case "generic":
    default:
      // What every marker used to be. Kept as the honest default for anything unclassified.
      return new THREE.SphereGeometry(0.06, 10, 8);
  }
}

const cache = new Map<PlacementSymbol, THREE.BufferGeometry>();

const FLOOR_ANCHORED_SYMBOLS = new Set<PlacementSymbol>([
  "floor_lamp", "lamp_post", "floor_spot", "robot_vacuum", "heat_pump_outdoor", "homepod",
  "network_switch", "fan", "humidifier", "radiator", "floor_heating", "dishwasher", "fridge",
  "freezer", "washing_machine", "dryer", "toilet", "sauna_heater_electric",
  "sauna_heater_wood", "tv", "server_rack", "router", "nvr", "nas", "media_player",
  "tree",
]);

function fitPhysicalEnvelope(symbol: PlacementSymbol, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const target = PHYSICAL_SYMBOL_SIZE[symbol];
  if (!target) return geometry;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  geometry.scale(target[0] / size.x, target[1] / size.y, target[2] / size.z);
  if (FLOOR_ANCHORED_SYMBOLS.has(symbol)) {
    geometry.computeBoundingBox();
    geometry.translate(0, -geometry.boundingBox!.min.y, 0);
  }
  return geometry;
}

export function symbolGeometry(symbol: PlacementSymbol): THREE.BufferGeometry {
  let geometry = cache.get(symbol);
  if (!geometry) {
    geometry = fitPhysicalEnvelope(symbol, buildRaw(symbol));
    geometry.computeBoundingBox();
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
  entityId?: string | null;
}): PlacementSymbol {
  const category = input.category ?? "";
  const mount = input.mountKind ?? "floor";
  const domain = input.entityId?.split(".", 1)[0];

  if (domain === "climate") return "heat_pump_indoor";
  if (domain === "vacuum") return "robot_vacuum";
  if (domain === "fan") return "fan";
  if (domain === "humidifier") return "humidifier";
  if (domain === "camera") return "security_camera";
  if (domain === "remote") return "remote_control";

  // This recovers a useful silhouette for older placements whose explicit symbol was lost. HA
  // imports commonly use the broad `appliance` category, while the entity domain stays precise.
  if (domain === "sensor" || domain === "binary_sensor") return "sensor";
  if (domain === "light") {
    if (mount === "ceiling") return input.isOutdoor ? "downlight" : "ceiling_lamp";
    if (mount === "wall") return "wall_lamp";
    if (input.isOutdoor) return mount === "free" ? "spike_spot" : "lamp_post";
    return "floor_lamp";
  }

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
