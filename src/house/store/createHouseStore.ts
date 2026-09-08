/**
 * The house workspace store: one zustand 5 store, sliced, with `subscribeWithSelector`.
 *
 * **Only ids, enums and primitives live here.** No `Object3D`, no `Material`, no `Vector3` — those
 * belong to the `SceneIndex` behind a non-reactive ref, so HA traffic and camera motion can never
 * invalidate a React selector.
 *
 * zustand 5 pitfall: v5 dropped the implicit shallow comparison for object-returning selectors, so
 * every multi-field selector must go through `useShallow` (re-exported from `hooks/useHouseStore`).
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { createColorSlice, type ColorSlice } from "./slices/color";
import { createEditSlice, type EditSlice } from "./slices/edit";
import { createLayerSlice, type LayerSlice } from "./slices/layer";
import { createModelSlice, type ModelSlice } from "./slices/model";
import { createRouteSlice, type RouteSlice } from "./slices/route";
import { createSelectionSlice, type SelectionSlice } from "./slices/selection";
import { createViewSlice, type ViewSlice } from "./slices/view";

export type Mutators = [["zustand/subscribeWithSelector", never]];

export type HouseStore = ModelSlice &
  SelectionSlice &
  ViewSlice &
  LayerSlice &
  ColorSlice &
  EditSlice &
  RouteSlice;

export type HouseStoreApi = StoreApi<HouseStore> & {
  subscribe: {
    (listener: (state: HouseStore, prev: HouseStore) => void): () => void;
    <U>(
      selector: (state: HouseStore) => U,
      listener: (selected: U, previous: U) => void,
      options?: { equalityFn?: (a: U, b: U) => boolean; fireImmediately?: boolean },
    ): () => void;
  };
};

export function createHouseStore(): HouseStoreApi {
  return createStore<HouseStore>()(
    subscribeWithSelector((...a) => ({
      ...createModelSlice(...a),
      ...createSelectionSlice(...a),
      ...createViewSlice(...a),
      ...createLayerSlice(...a),
      ...createColorSlice(...a),
      ...createEditSlice(...a),
      ...createRouteSlice(...a),
    })),
  ) as HouseStoreApi;
}
