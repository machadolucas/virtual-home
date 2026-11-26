import { DEFAULT_LAYERS } from "../model/types";
import type { HouseStore } from "../store/createHouseStore";

/** A rendering projection only. Desktop selection, editors, URL and saved settings keep their values. */
export function presentedHouse(state: HouseStore): HouseStore {
  if (state.immersiveMode !== "vr") return state;
  return { ...state, viewMode: "overview", projection: "perspective", activeFloorId: null,
    wallMode: "closed", roofVisible: true, ceilingsVisible: true, edgesVisible: false,
    selection: null, hover: null, focusSelection: null, editing: null, routeDraft: null,
    cut: { ...state.cut, enabled: false, vertical: null }, explode: { ...state.explode, enabled: false },
    layers: { ...DEFAULT_LAYERS, routes: false, annotations: false } };
}

export type ImmersiveMode = "vr" | "mr" | "survey";
export const sessionModes = { vr: "immersive-vr", mr: "immersive-ar", survey: "immersive-ar" } as const;
export function requestHouseSession(xr: XRSystem, mode: ImmersiveMode) {
  const optionalFeatures = mode === "vr" ? ["hand-tracking"]
    : ["anchors", "plane-detection", "mesh-detection", "hit-test", "hand-tracking"];
  return xr.requestSession(sessionModes[mode], {
    requiredFeatures: ["local-floor"], optionalFeatures,
  });
}

export async function probeModes(xr: XRSystem | undefined, secure: boolean) {
  if (!secure || !xr) return { vr: false, mr: false };
  const probe = (mode: XRSessionMode) => xr.isSessionSupported(mode).catch(() => false);
  const [vr, mr] = await Promise.all([probe(sessionModes.vr), probe(sessionModes.mr)]);
  return { vr, mr };
}
