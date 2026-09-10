/**
 * `window.__vh` — the browser-test surface described in the verification plan.
 *
 * Mounted **only** when `NEXT_PUBLIC_VH_TEST_HOOK === '1'`, so it is dead-code-eliminated from a
 * production bundle. It only reads state and dispatches actions the UI already exposes: it is not
 * a back door around authentication or around the store's own invariants.
 */
import { isVisibleUp } from "../scene/applyVisibility";
import * as THREE from "three";
import CameraControlsImpl from "camera-controls";
import { allMaterialHex, materialHex } from "@/house/scene/applyColors";
import { worldY } from "@/house/scene/explode";
import type { PickResult } from "@/house/scene/picker";
import type { Selection } from "@/house/model/types";
import type { HouseRuntime } from "../runtime";

export interface VhFrameStats {
  frames: number;
  avgMs: number;
  p95Ms: number;
  reset(): void;
}

export interface VhHook {
  ready: Promise<void>;
  settled: Promise<void>;
  status(): {
    phase: string;
    modelId: string | null;
    fingerprint: string | null;
    loadedAssetIds: string[];
    failedAssetIds: string[];
    diagnostics: Array<{ severity: string; code: string; message: string }>;
  };
  materialHex(surfaceId: string): string | null;
  allMaterialHex(): Record<string, string>;
  materialAudit(): Array<{ assetId: string; materialCount: number; cloned: number }>;
  visible(assetId: string, nodeName: string): boolean;
  worldY(assetId: string, nodeName: string): number | null;
  clipPlanes(surfaceId: string): Array<{ normal: [number, number, number]; constant: number }>;
  pickables(): number;
  select(selection: Selection | null): void;
  selection(): Selection | null;
  /** Whether the camera controls currently accept the left button, or `null` if not mounted. */
  controlsEnabled(): boolean | null;
  controlBindings(): { left: number; right: number; wheel: number } | null;
  camera(): { position: [number, number, number]; target: [number, number, number]; projection: string };
  screenOf(world: [number, number, number]): [number, number] | null;
  roomAnchor(roomId: string): [number, number, number] | null;
  pick(cssX: number, cssY: number): PickResult | null;
  renderInfo(): {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
    shadowMapEnabled: boolean;
  };
  frameStats(): VhFrameStats;
  frameDrivers(): { lightFading: boolean; controlsActive: boolean; controlAction: number; invalidations: number };
  invalidateCount(): number;
  lights(): import("../scene/equipmentLights").EquipmentLightSpec[];
  detectionGuide(): { visible: boolean; position: number[]; direction: number[] };
  equipmentCount(): number;
  furnishings(): Array<{ id: string; visible: boolean; size: [number, number, number] }>;
  occlusionStats(): { queries: number; batches: number };
  daylight(): { position: number[]; intensity: number; shadowMapSize: number; shadowMapAllocated: boolean; radius: number } | null;
  lightProjections(): import("../scene/equipmentLights").RenderedEquipmentLightProjection[];
  shadowPassCount(): number;
  lightingBatches(): { rendered: number; reused: number; batches: number; litSurfaces: number; unlitSurfaces: number } | null;
  renderedLights(): import("../scene/equipmentLights").RenderedEquipmentLight[];
  shadowSurface(surfaceId: string): {
    castShadow: boolean;
    receiveShadow: boolean;
    clipShadows: boolean;
    roughness: number | null;
  } | null;
  lastSavePayload(): unknown;
  disposedInfo(): { geometries: number; textures: number } | null;
}

declare global {
  interface Window {
    __vh?: VhHook;
  }
}

export const TEST_HOOK_ENABLED = process.env.NEXT_PUBLIC_VH_TEST_HOOK === "1";

export function installTestHook(runtime: HouseRuntime, camera: THREE.Camera): (() => void) | void {
  if (!TEST_HOOK_ENABLED || typeof window === "undefined") return;

  const deferredReady = deferred();
  const deferredSettled = deferred();
  let shadowPasses = 0;
  const shadowObservers = new Map<THREE.Mesh, THREE.Mesh["onBeforeShadow"]>();
  let disposed: { geometries: number; textures: number } | null = null;

  const unsubscribe = runtime.store.subscribe(
    (s) => s.phase,
    (phase) => {
      if (phase === "interactive" || phase === "ready" || phase === "degraded") deferredReady.resolve();
      if (phase === "ready" || phase === "degraded" || phase === "failed") deferredSettled.resolve();
    },
    { fireImmediately: true },
  );

  // rAF frame sampler. It only samples frames that are actually produced, which is the meaningful
  // measure under `frameloop="demand"`.
  const deltas: number[] = [];
  let last = performance.now();
  let rafHandle = 0;
  const sample = () => {
    const now = performance.now();
    deltas.push(now - last);
    last = now;
    if (deltas.length > 600) deltas.shift();
    rafHandle = requestAnimationFrame(sample);
  };
  rafHandle = requestAnimationFrame(sample);

  const hook: VhHook = {
    ready: deferredReady.promise,
    settled: deferredSettled.promise,

    status() {
      const s = runtime.store.getState();
      return {
        phase: s.phase,
        modelId: s.modelId,
        fingerprint: s.fingerprint,
        loadedAssetIds: [...s.loadedAssetIds],
        failedAssetIds: [...s.failedAssetIds],
        diagnostics: s.diagnostics.map((d) => ({
          severity: d.severity,
          code: d.code,
          message: d.message,
        })),
      };
    },

    materialHex(surfaceId) {
      return runtime.index ? materialHex(runtime.index, surfaceId) : null;
    },

    allMaterialHex() {
      return runtime.index ? allMaterialHex(runtime.index) : {};
    },

    materialAudit() {
      return runtime.materialAudits.map((a) => ({
        assetId: a.assetId,
        materialCount: a.materialCount,
        cloned: a.cloned,
      }));
    },

    visible(assetId, nodeName) {
      const node = runtime.index?.assets.get(assetId)?.nodes.get(nodeName);
      if (!node) return false;
      let o: THREE.Object3D | null = node;
      while (o) {
        if (!o.visible) return false;
        o = o.parent;
      }
      return true;
    },

    worldY(assetId, nodeName) {
      return runtime.index ? worldY(runtime.index, assetId, nodeName) : null;
    },

    clipPlanes(surfaceId) {
      return (runtime.clip?.planesFor(surfaceId) ?? []).map((plane) => ({
        normal: [plane.normal.x, plane.normal.y, plane.normal.z],
        constant: plane.constant,
      }));
    },

    pickables() {
      return runtime.index?.pickables.length ?? 0;
    },

    select(selection) {
      runtime.select(selection);
    },

    selection() {
      return runtime.store.getState().selection;
    },

    /**
     * Whether camera controls currently own the left button. The controls instance itself stays
     * enabled so wheel zoom and right-button trucking remain available.
     */
    controlsEnabled() {
      const controls = runtime.controls;
      return controls ? controls.mouseButtons.left !== CameraControlsImpl.ACTION.NONE : null;
    },

    controlBindings() {
      const controls = runtime.controls;
      return controls
        ? {
            left: controls.mouseButtons.left,
            right: controls.mouseButtons.right,
            wheel: controls.mouseButtons.wheel,
          }
        : null;
    },

    camera() {
      const pose = runtime.camera?.pose() ?? {
        position: [0, 0, 0] as [number, number, number],
        target: [0, 0, 0] as [number, number, number],
      };
      return { ...pose, projection: runtime.store.getState().projection };
    },

    screenOf(world) {
      const el = runtime.canvasEl;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const v = vector(world).project(camera);
      return [(v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height];
    },

    roomAnchor(roomId) {
      return runtime.manifest?.roomAnchors.get(roomId)?.point ?? null;
    },

    pick(cssX, cssY) {
      const el = runtime.canvasEl;
      const index = runtime.index;
      const clip = runtime.clip;
      const picker = runtime.picker;
      if (!el || !index || !clip || !picker) return null;
      const rect = el.getBoundingClientRect();
      return picker.pick(cssX + rect.left, cssY + rect.top, rect, camera, index, clip);
    },

    renderInfo() {
      const gl = rendererOf(runtime);
      if (!gl) return {
        calls: 0,
        triangles: 0,
        geometries: 0,
        textures: 0,
        programs: 0,
        shadowMapEnabled: false,
      };
      return {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
        shadowMapEnabled: gl.shadowMap.enabled,
      };
    },

    frameStats() {
      const sorted = [...deltas].sort((a, b) => a - b);
      const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      const p95 = sorted.length ? (sorted[Math.floor(sorted.length * 0.95)] ?? 0) : 0;
      return {
        frames: deltas.length,
        avgMs: avg,
        p95Ms: p95,
        reset() {
          deltas.length = 0;
          last = performance.now();
        },
      };
    },

    lights() { return runtime.equipmentLights?.snapshot() ?? []; },

    detectionGuide() {
      const guide = runtime.scene?.children.find((o) => o.userData.detectionGuide);
      return { visible: Boolean(guide?.visible && guide.children.length), position: guide?.position.toArray() ?? [], direction: guide ? new THREE.Vector3(0, 1, 0).applyQuaternion(guide.quaternion).toArray() : [] };
    },

    occlusionStats() { return { queries: runtime.occlusion.queries, batches: runtime.occlusion.batches }; },

    equipmentCount() {
      let count = 0;
      runtime.index?.overlay.root.traverse((o) => { if (o instanceof THREE.InstancedMesh && o.name.startsWith("vh-markers-") && isVisibleUp(o)) count += o.count; });
      return count;
    },

    furnishings() {
      const out: Array<{ id: string; visible: boolean; size: [number, number, number] }> = [];
      runtime.scene?.updateMatrixWorld(true);
      runtime.scene?.traverse((object) => {
        if (!object.name.startsWith("furnishing:")) return;
        const physical = object.userData.furnishingSize as [number, number, number] | undefined;
        const size = physical
          ? new THREE.Vector3(physical[0], physical[1], physical[2])
          : new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
        out.push({
          id: object.name.slice("furnishing:".length),
          visible: isVisibleUp(object),
          size: [size.x, size.y, size.z],
        });
      });
      return out;
    },

    daylight() {
      const light = runtime.scene?.getObjectByName("vh-daylight") as THREE.DirectionalLight | undefined;
      return light ? { position: light.position.toArray(), intensity: light.intensity, shadowMapSize: light.shadow.mapSize.x, shadowMapAllocated: light.shadow.map !== null, radius: light.shadow.radius } : null;
    },

    lightProjections() { return runtime.equipmentLights?.projectedSnapshot() ?? []; },

    frameDrivers() { return { lightFading: runtime.equipmentLights?.fading ?? false, controlsActive: runtime.controls?.active ?? false, controlAction: runtime.controls?.currentAction ?? 0, invalidations: runtime.invalidateCount }; },
    lightingBatches() { return runtime.batchedLighting ? { ...runtime.batchedLighting.stats } : null; },
    shadowPassCount() {
      for (const asset of runtime.index?.assets.values() ?? []) for (const mesh of asset.meshes) {
        if (shadowObservers.has(mesh)) continue;
        const original = mesh.onBeforeShadow;
        shadowObservers.set(mesh, original);
        mesh.onBeforeShadow = function (...args) { shadowPasses++; original.apply(this, args); };
      }
      return shadowPasses;
    },

    renderedLights() { return runtime.equipmentLights?.renderedSnapshot() ?? []; },

    shadowSurface(surfaceId) {
      const mesh = runtime.index?.surfaceMesh.get(surfaceId);
      if (!mesh || Array.isArray(mesh.material)) return null;
      const material = mesh.material as THREE.MeshStandardMaterial;
      return {
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        clipShadows: material.clipShadows,
        roughness: "roughness" in material ? material.roughness : null,
      };
    },

    invalidateCount() {
      return runtime.invalidateCount;
    },

    lastSavePayload() {
      return runtime.lastSavePayload;
    },

    disposedInfo() {
      return disposed;
    },
  };

  window.__vh = hook;

  return () => {
    cancelAnimationFrame(rafHandle);
    for (const [mesh, original] of shadowObservers) mesh.onBeforeShadow = original;
    shadowObservers.clear();
    unsubscribe();
    const gl = rendererOf(runtime);
    disposed = gl ? { geometries: gl.info.memory.geometries, textures: gl.info.memory.textures } : { geometries: 0, textures: 0 };
    if (window.__vh === hook) {
      // Keep `disposedInfo()` readable after unmount; the rest is inert.
      window.__vh = { ...hook, disposedInfo: () => disposed };
    }
  };
}

function rendererOf(runtime: HouseRuntime): THREE.WebGLRenderer | null {
  return runtime.gl;
}

function vector(v: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
