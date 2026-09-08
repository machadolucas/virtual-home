/**
 * The non-reactive runtime handed around by context.
 *
 * Nothing here is React state: it is the imperative scene, the store handle, the data seam and a
 * couple of callbacks. Components read it through `useHouseRuntime()` and never re-render because
 * of it, which is what keeps HA traffic and camera motion off the React render path.
 */
import type * as THREE from "three";
import type { ManifestIndex } from "./model/manifestIndex";
import type { ExplodeGroup, Selection } from "./model/types";
import type { ClipGroups } from "./scene/clipGroups";
import type { Highlighter } from "./scene/highlight";
import type { MarkerLayer } from "./scene/markers";
import type { PickResult, Picker } from "./scene/picker";
import type { RouteLayer } from "./scene/routes";
import type { SceneIndex } from "./scene/SceneIndex";
import type { SnapIndicatorState } from "./scene/snap";
import type { HouseDataApi } from "./store/dataApi";
import type { HouseStoreApi } from "./store/createHouseStore";

export interface CameraApi {
  overview(): Promise<void>;
  fitBox(box: THREE.Box3, opts?: { padding?: number; clampPolar?: boolean }): Promise<void>;
  frameRoom(roomId: string): Promise<void>;
  frameFloor(floorId: string): Promise<void>;
  frameBuilding(buildingId: string): Promise<void>;
  frameSelection(): Promise<void>;
  frameEquipment(placementId: string): Promise<void>;
  planFor(floorId: string): Promise<void>;
  orbit(dAzimuthDeg: number, dPolarDeg: number): void;
  truck(dx: number, dy: number): void;
  dolly(delta: number): void;
  pose(): { position: [number, number, number]; target: [number, number, number] };
}

export interface HouseRuntime {
  store: HouseStoreApi;
  dataApi: HouseDataApi;
  /** `/api/house-model/<modelId>` */
  base: string;
  manifest: ManifestIndex | null;
  scene: THREE.Scene | null;
  index: SceneIndex | null;
  clip: ClipGroups | null;
  highlighter: Highlighter | null;
  picker: Picker | null;
  markers: MarkerLayer | null;
  routes: RouteLayer | null;
  camera: CameraApi | null;
  /** The active three camera, published by `SceneRoot` for the picker and the editors. */
  camera3d: THREE.Camera | null;
  /** The default camera controls, so the tool can decide who owns the left button. */
  controls: { enabled: boolean } | null;
  /**
   * Hand the camera to the pointer, or take it away.
   *
   * A method rather than a bare mutation at the call site: the controls object comes out of a hook
   * result, and mutating one of those from component code is exactly what the compiler's
   * immutability rule (rightly) refuses. The runtime owns the object, so the runtime changes it.
   */
  setControlsEnabled(enabled: boolean): void;
  canvasEl: HTMLCanvasElement | null;
  /** The R3F renderer, published by `SceneRoot` for the test hook's render-info assertions. */
  gl: THREE.WebGLRenderer | null;
  invalidate(): void;
  /** Number of `invalidate()` calls — the idle test asserts this stays flat. */
  invalidateCount: number;
  offsets: Map<ExplodeGroup, number>;
  /**
   * The one selection path. `SceneRoot` replaces it with a version that paints the highlight
   * synchronously before writing the store; the baseline below still writes the store, so the
   * tree, the search box and the inspector keep working when the canvas is absent or has crashed.
   */
  select(selection: Selection | null, opts?: { frame?: boolean }): void;
  lastPick: PickResult | null;
  lastSavePayload: unknown;
  materialAudits: Array<{ assetId: string; materialCount: number; cloned: number }>;
  /**
   * The live snap indicator. It carries `Vector3`s and a wall frame, so it cannot live in the
   * store; the editor panel (outside the canvas) writes it and the in-canvas indicator layer
   * subscribes. One field plus a listener set, so a drag never re-renders React.
   */
  snapIndicator: SnapIndicatorState | null;
  setSnapIndicator(state: SnapIndicatorState | null): void;
  onSnapIndicator(listener: (state: SnapIndicatorState | null) => void): () => void;
}

export function createRuntime(init: {
  store: HouseStoreApi;
  dataApi: HouseDataApi;
  base: string;
}): HouseRuntime {
  const snapListeners = new Set<(state: SnapIndicatorState | null) => void>();
  const runtime: HouseRuntime = {
    store: init.store,
    dataApi: init.dataApi,
    base: init.base,
    manifest: null,
    scene: null,
    index: null,
    clip: null,
    highlighter: null,
    picker: null,
    markers: null,
    routes: null,
    camera: null,
    camera3d: null,
    controls: null,
    setControlsEnabled(enabled) {
      if (this.controls) this.controls.enabled = enabled;
    },
    canvasEl: null,
    gl: null,
    invalidate() {},
    invalidateCount: 0,
    offsets: new Map(),
    select() {},
    lastPick: null,
    lastSavePayload: null,
    materialAudits: [],
    snapIndicator: null,
    setSnapIndicator(state) {
      this.snapIndicator = state;
      for (const listener of snapListeners) listener(state);
    },
    onSnapIndicator(listener) {
      snapListeners.add(listener);
      return () => {
        snapListeners.delete(listener);
      };
    },
  };
  runtime.select = baseSelect(runtime);
  return runtime;
}

/**
 * Selection without the canvas: writes the store (and frames, if a camera exists). `SceneRoot`
 * layers the synchronous highlight on top and restores this on unmount.
 */
export function baseSelect(
  runtime: HouseRuntime,
): (selection: Selection | null, opts?: { frame?: boolean }) => void {
  return (selection, opts) => {
    runtime.store.getState().setSelection(selection);
    if (opts?.frame) void runtime.camera?.frameSelection();
  };
}
