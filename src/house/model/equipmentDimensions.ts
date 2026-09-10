import type { Vec3 } from "./types";

/**
 * Physical symbol envelopes in site metres: width (X), height (Y), depth (Z).
 *
 * These are ordinary representative household sizes, not persisted equipment measurements. Solar
 * panels and LED bars are deliberately absent because their saved placement dimensions remain the
 * authority. Tiny controls and the generic pin already use their physical authored dimensions.
 */
export const PHYSICAL_SYMBOL_SIZE: Readonly<Record<string, Vec3>> = {
  ceiling_lamp: [0.4, 0.25, 0.4],
  wall_lamp: [0.25, 0.25, 0.22],
  floor_lamp: [0.4, 1.5, 0.4],
  lamp_post: [0.3, 1.5, 0.3],
  wall_spot: [0.12, 0.12, 0.18],
  floor_spot: [0.3, 1.5, 0.3],
  ceiling_spot: [0.12, 0.14, 0.12],
  spike_spot: [0.12, 0.25, 0.12],
  downlight: [0.1, 0.06, 0.1],
  vent: [0.3, 0.04, 0.2],
  sensor: [0.08, 0.1, 0.04],
  motion_sensor: [0.08, 0.11, 0.06],
  wifi_access_point: [0.18, 0.04, 0.18],
  robot_vacuum: [0.35, 0.1, 0.35],
  heat_pump_indoor: [0.8, 0.3, 0.22],
  heat_pump_outdoor: [0.8, 0.65, 0.35],
  homepod: [0.14, 0.17, 0.14],
  network_switch: [0.44, 0.044, 0.25],
  security_camera: [0.1, 0.12, 0.28],
  fan: [0.45, 1.2, 0.35],
  humidifier: [0.25, 0.5, 0.25],
  tree: [3, 5, 3],
  radiator: [1, 0.6, 0.12],
  floor_heating: [1, 0.02, 1],
  dishwasher: [0.6, 0.8, 0.6],
  fridge: [0.6, 1.86, 0.65],
  freezer: [0.6, 1.86, 0.65],
  washing_machine: [0.6, 0.85, 0.65],
  dryer: [0.6, 0.85, 0.65],
  water_tap: [0.18, 0.3, 0.08],
  shower: [0.25, 0.65, 0.15],
  toilet: [0.38, 0.78, 0.7],
  sink: [0.6, 0.25, 0.5],
  sauna_heater_electric: [0.4, 0.7, 0.36],
  sauna_heater_wood: [0.5, 1, 0.55],
  tv: [1.1, 0.7, 0.12],
  server_rack: [0.6, 1.8, 1],
  router: [0.25, 0.2, 0.18],
  nvr: [0.32, 0.08, 0.24],
  nas: [0.2, 0.28, 0.25],
  media_player: [0.2, 0.05, 0.2],
};

/** Visible light-source locations, relative to the unchanged placement/mount origin. */
export const PHYSICAL_LIGHT_SOURCE_OFFSET: Readonly<Record<string, Vec3>> = {
  ceiling_lamp: [0, -0.22, 0],
  wall_lamp: [0, 0.15, 0.2],
  lamp_post: [0, 1.31, 0],
  floor_lamp: [0, 1.33, 0],
  wall_spot: [0, 0.07, 0.17],
  floor_spot: [0, 1.33, 0.12],
  ceiling_spot: [0.055, -0.1, 0],
  spike_spot: [0, 0.12, 0],
  downlight: [0, -0.05, 0],
  motion_sensor: [0, 0.07, 0.055],
  security_camera: [0, 0.075, 0.27],
};
