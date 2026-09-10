import { z } from "zod";
import type { HouseStore, HouseStoreApi } from "./createHouseStore";
import { initialView } from "./slices/view";
import { DETAILED_LIGHT_SLIDER_MAX } from "../model/detailedLightBudget";

export const RENDERING_PREFERENCES_KEY = "vh-rendering-preferences-v1";

const illuminationSchema = z.object({
  mode: z.enum(["live", "manual", "studio"]),
  atMs: z.number().int().min(0).max(8_640_000_000_000_000).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  northDeg: z.number().min(-180).max(360).nullable(),
  softShadows: z.boolean(),
  intensity: z.number().min(0).max(3),
});
const schema = z.object({
  version: z.literal(1),
  performanceMode: z.boolean(),
  detailedLightBatched: z.boolean(),
  detailedLightAll: z.boolean(),
  detailedLightLimit: z.number().int().min(0).max(DETAILED_LIGHT_SLIDER_MAX),
  detailedLightExperimental: z.boolean(),
  illumination: illuminationSchema,
});
type Preferences = z.infer<typeof schema>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Persist user choices only. GPU capabilities, errors, camera/edit state and HA event addresses
 * belong to the current runtime. Background already has its own household-level persistence. */
function preferencesOf(state: HouseStore): Preferences {
  const { mode, atMs, latitude, longitude, northDeg, softShadows, intensity } = state.illumination;
  return {
    version: 1,
    performanceMode: state.performanceMode,
    detailedLightBatched: state.detailedLightBatched,
    detailedLightAll: state.detailedLightAll,
    detailedLightLimit: state.detailedLightLimit,
    detailedLightExperimental: state.detailedLightExperimental,
    illumination: { mode, atMs, latitude, longitude, northDeg, softShadows, intensity },
  };
}

export function restoreRenderingPreferences(store: HouseStoreApi, text: string | null): void {
  if (!text) return;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) return;
    const { illumination, performanceMode, detailedLightBatched, detailedLightAll, detailedLightLimit, detailedLightExperimental } = parsed.data;
    store.setState((state) => ({
      performanceMode, detailedLightBatched, detailedLightLimit, detailedLightExperimental,
      detailedLightAll: detailedLightBatched && detailedLightAll,
      illumination: { ...state.illumination, ...illumination },
    }));
  } catch { /* Invalid or older preferences leave the viewer's defaults intact. */ }
}

/** Start after client mount; no browser reads during SSR and no render-frame storage writes. */
export function rememberRenderingPreferences(store: HouseStoreApi, storage: Storage): () => void {
  try { restoreRenderingPreferences(store, storage.getItem(RENDERING_PREFERENCES_KEY)); }
  catch { /* Restricted browser storage is optional. */ }
  let previous = JSON.stringify(preferencesOf(store.getState()));
  return store.subscribe((state) => {
    const next = JSON.stringify(preferencesOf(state));
    if (next === previous) return;
    previous = next;
    try { storage.setItem(RENDERING_PREFERENCES_KEY, next); }
    catch { /* Quota/private-browser restrictions must not break scene controls. */ }
  });
}

export function resetRenderingPreferences(store: HouseStoreApi): void {
  const { mode, atMs, latitude, longitude, northDeg, softShadows, intensity } = initialView.illumination;
  store.setState((state) => ({
    performanceMode: initialView.performanceMode,
    detailedLightBatched: initialView.detailedLightBatched,
    detailedLightAll: initialView.detailedLightAll,
    detailedLightLimit: initialView.detailedLightLimit,
    detailedLightExperimental: initialView.detailedLightExperimental,
    detailedLightError: null,
    illumination: { ...state.illumination, mode, atMs, latitude, longitude, northDeg, softShadows, intensity },
  }));
}
