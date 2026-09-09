"use client";
/* eslint-disable react-hooks/immutability -- `HouseRuntime` is a deliberately mutable,
   non-reactive box handed around by context (see `src/house/runtime.ts`): the imperative layer
   publishes its handles onto it and React never re-renders because of it. The React Compiler
   rule assumes a hook's return value is immutable, which is precisely the assumption this
   design breaks on purpose — the alternative is putting `Object3D`s in React state. */
/**
 * The imperative subtree: it owns the scene index, the clipping planes, the loader, the picker and
 * the overlay layers, and it is the only place that adds loaded GLB roots to the scene.
 *
 * Loaded roots go to `scene.add(root)` directly, **not** through `<primitive object={root} />`.
 * Consequences, all deliberate: R3F's event system never traverses ~400 objects on a pointer move,
 * there is exactly one picking implementation (ours, clip-aware), and React never reconciles the
 * shell. R3F still owns the render loop, camera, controls, lights and the marker/route layers.
 */
import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { groupsOf } from "@/house/model/explodeGroups";
import { OVERVIEW_PRESET } from "@/house/model/visibilityPlan";
import { ClipGroups } from "@/house/scene/clipGroups";
import { disposeViewer } from "@/house/scene/dispose";
import { Highlighter, highlightTargets } from "@/house/scene/highlight";
import { loadTier, planTiers, scanTier, structureTier } from "@/house/scene/loadAssets";
import { MarkerLayer } from "@/house/scene/markers";
import { auditMaterials } from "@/house/scene/materialAudit";
import { CLICK_SLOP_MOUSE, CLICK_SLOP_TOUCH, Picker } from "@/house/scene/picker";
import { RouteLayer } from "@/house/scene/routes";
import { createSceneIndex, indexAsset, makeNonPickable } from "@/house/scene/SceneIndex";
import type { Selection } from "@/house/model/types";
import { baseSelect } from "@/house/runtime";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { useIsPhone, useIsTouch } from "../hooks/useReducedMotion";
import { usePaletteSync } from "../hooks/usePaletteSync";
import { useDetectionGuide } from "../hooks/useDetectionGuide";
import { useEquipmentLights } from "../hooks/useEquipmentLights";
import { useSceneSync } from "../hooks/useSceneSync";
import { installTestHook } from "../test/testHook";

export function SceneRoot() {
  const runtime = useHouseRuntime();
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const phase = useHouseStore((s) => s.phase);
  const fingerprint = useHouseStore((s) => s.fingerprint);
  const structureLayer = useHouseStore((s) => s.layers.structure);
  const scanLayer = useHouseStore((s) => s.layers.scanReferences);
  const phone = useIsPhone();
  const touch = useIsTouch();

  const tokenRef = useRef(0);
  const loadedTiersRef = useRef<Set<string>>(new Set());

  // ---- invalidate plumbing ---------------------------------------------
  useEffect(() => {
    runtime.scene = scene;
    runtime.canvasEl = gl.domElement;
    runtime.gl = gl;
    runtime.camera3d = camera;
    runtime.invalidate = () => {
      runtime.invalidateCount++;
      invalidate();
    };
    return () => {
      runtime.scene = null;
      runtime.canvasEl = null;
      runtime.gl = null;
      runtime.camera3d = null;
      runtime.invalidate = () => {};
    };
  }, [runtime, scene, gl, camera, invalidate]);

  // ---- selection path --------------------------------------------------
  useEffect(() => {
    runtime.select = (selection: Selection | null, opts) => {
      const index = runtime.index;
      const clip = runtime.clip;
      // Paint the acknowledgement synchronously, before React hears about it: the visual feedback
      // is then bounded by one frame rather than by however long the inspector takes to render.
      if (index && clip && runtime.highlighter) {
        const targets = highlightTargets(index, selection);
        runtime.highlighter.set(index, clip, targets.ids, null, {
          intensity: targets.intensity,
          primary: targets.primary,
        });
        runtime.invalidate();
      }
      const state = runtime.store.getState();
      state.setSelection(selection);
      if (selection === null || opts?.frame || opts?.focus) {
        state.setFocusSelection(selection);
        if (selection && !state.wallModeExplicit)
          state.setWallMode(selection.kind === "building" ? "closed" : "contextual", false);
      }
      if (opts?.frame) void runtime.camera?.frameSelection();
    };
    return () => {
      // Back to the store-only path, so the tree and the inspector keep working.
      runtime.select = baseSelect(runtime);
    };
  }, [runtime]);

  // ---- scene construction ---------------------------------------------
  useEffect(() => {
    const manifest = runtime.manifest;
    if (!manifest) return;

    const index = createSceneIndex(manifest);
    const clip = new ClipGroups(groupsOf(manifest));
    const highlighter = new Highlighter(scene);
    const markers = new MarkerLayer(index, clip);
    const routes = new RouteLayer(index, clip);

    scene.add(index.overlay.root);
    runtime.index = index;
    runtime.clip = clip;
    runtime.highlighter = highlighter;
    runtime.picker = new Picker();
    runtime.markers = markers;
    runtime.routes = routes;
    runtime.materialAudits = [];

    return () => {
      highlighter.dispose();
      markers.dispose();
      routes.dispose();
      disposeViewer(index, scene);
      runtime.index = null;
      runtime.clip = null;
      runtime.highlighter = null;
      runtime.picker = null;
      runtime.markers = null;
      runtime.routes = null;
    };
  }, [runtime, scene, fingerprint]);

  // ---- tiered loading --------------------------------------------------
  useEffect(() => {
    const manifest = runtime.manifest;
    const index = runtime.index;
    const clip = runtime.clip;
    if (!manifest || !index || !clip || !fingerprint || phase === "failed" || phase === "idle") return;

    const controller = new AbortController();
    // React 19 StrictMode double-mounts this effect; the token makes a late `onAsset` from the
    // first mount dispose its root instead of doubling the scene.
    const token = ++tokenRef.current;
    const store = runtime.store;
    loadedTiersRef.current = new Set();

    const onAsset = (assetId: string, root: import("three").Group) => {
      if (controller.signal.aborted || tokenRef.current !== token) return;
      scene.add(root);
      const entry = indexAsset(index, assetId, root);
      runtime.materialAudits.push(auditMaterials(entry));
      for (const mesh of entry.meshes) {
        const sid = index.meshSurfaceId.get(mesh);
        if (sid) clip.attach(mesh, index.clipGroupOf.get(sid) ?? "site", sid);
      }
      if (entry.edges) clip.attach(entry.edges, index.clipGroupOf.get(assetId) ?? "site");
      // Scan references are evidence only: never picked, so they never enter a ray test.
      if (manifest.assets.get(assetId)?.kind === "scan-reference") makeNonPickable(entry);
      store.getState().assetLoaded(assetId);
      runtime.invalidate();
    };

    const onFail = (assetId: string, error: unknown) => {
      if (controller.signal.aborted || tokenRef.current !== token) return;
      store.getState().assetFailed(assetId);
      console.warn(`[house] asset ${assetId} failed to load`, error);
    };

    void (async () => {
      const tiers = planTiers(manifest, { structureLayer, phone });
      const ctx = {
        base: runtime.base,
        fingerprint,
        signal: controller.signal,
        token,
        currentToken: () => tokenRef.current,
      };

      const first = tiers[0];
      if (first) {
        store.getState().setPhase("loading");
        const result = await loadTier(first, ctx, { onAsset, onFail });
        if (controller.signal.aborted || tokenRef.current !== token) return;
        if (result.loaded.length === 0 && first.assets.length > 0) {
          store.getState().setFatal("tier0_failed", "None of the shell assets could be loaded.");
          return;
        }
        // Interactive the moment the shell is indexed, coloured and framed.
        store.getState().applyOverview();
        // Fire-and-forget: the transition promise resolves only when frames render, and under
        // frameloop="demand" awaiting it here stalled the phase (and the later tiers) until the
        // user interacted. The pump in useDemandFrames drives the animation regardless.
        void runtime.camera?.overview();
        store.getState().setPhase(result.failed.length ? "degraded" : "interactive");
        loadedTiersRef.current.add(first.name);
      }

      for (const tier of tiers.slice(1)) {
        if (controller.signal.aborted || tokenRef.current !== token) return;
        if (store.getState().phase !== "degraded") store.getState().setPhase("enriching");
        await loadTier(tier, ctx, { onAsset, onFail });
        loadedTiersRef.current.add(tier.name);
      }
      if (controller.signal.aborted || tokenRef.current !== token) return;
      if (store.getState().phase !== "degraded") store.getState().setPhase("ready");
    })();

    return () => {
      controller.abort();
    };
    // `structureLayer`/`phone` change which tiers exist; handled by the on-demand loader below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, scene, fingerprint, phase === "failed"]);

  // ---- on-demand tiers behind their layer toggles ----------------------
  useEffect(() => {
    const manifest = runtime.manifest;
    const index = runtime.index;
    const clip = runtime.clip;
    if (!manifest || !index || !clip || !fingerprint) return;
    if (phone) return; // the phone never loads structure or scan geometry

    const controller = new AbortController();
    const token = tokenRef.current;
    const store = runtime.store;

    const load = async (tier: ReturnType<typeof structureTier>) => {
      if (tier.assets.every((a) => index.assets.has(a.id))) return;
      const pending = { ...tier, assets: tier.assets.filter((a) => !index.assets.has(a.id)) };
      await loadTier(
        pending,
        {
          base: runtime.base,
          fingerprint,
          signal: controller.signal,
          token,
          currentToken: () => tokenRef.current,
        },
        {
          onAsset: (assetId, root) => {
            if (controller.signal.aborted) return;
            scene.add(root);
            const entry = indexAsset(index, assetId, root);
            runtime.materialAudits.push(auditMaterials(entry));
            for (const mesh of entry.meshes) {
              const sid = index.meshSurfaceId.get(mesh);
              if (sid) clip.attach(mesh, index.clipGroupOf.get(sid) ?? "site", sid);
            }
            if (entry.edges) clip.attach(entry.edges, index.clipGroupOf.get(assetId) ?? "site");
            if (manifest.assets.get(assetId)?.kind === "scan-reference") makeNonPickable(entry);
            store.getState().assetLoaded(assetId);
            runtime.invalidate();
          },
          onFail: (assetId) => store.getState().assetFailed(assetId),
        },
      );
    };

    if (structureLayer) void load(structureTier(manifest));
    if (scanLayer) void load(scanTier(manifest));

    return () => controller.abort();
  }, [runtime, scene, fingerprint, structureLayer, scanLayer, phone]);

  // ---- pointer handling ------------------------------------------------
  useEffect(() => {
    const el = gl.domElement;
    const down = { x: 0, y: 0, id: -1, moved: false };
    const slop = touch ? CLICK_SLOP_TOUCH : CLICK_SLOP_MOUSE;

    const onPointerDown = (event: PointerEvent) => {
      down.x = event.clientX;
      down.y = event.clientY;
      down.id = event.pointerId;
      down.moved = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (down.id === event.pointerId) {
        if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > slop) down.moved = true;
        return;
      }
      if (touch) return; // no hover on touch
      const index = runtime.index;
      const clip = runtime.clip;
      const picker = runtime.picker;
      if (!index || !clip || !picker) return;
      const hit = picker.pick(
        event.clientX,
        event.clientY,
        el.getBoundingClientRect(),
        camera,
        index,
        clip,
      );
      const next = hoverSelectionOf(hit);
      const current = runtime.store.getState().hover;
      if (sameSelection(current, next)) return;
      runtime.store.getState().setHover(next);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (down.id !== event.pointerId) return;
      const dragged = down.moved;
      down.id = -1;
      if (dragged) return;

      const index = runtime.index;
      const clip = runtime.clip;
      const picker = runtime.picker;
      if (!index || !clip || !picker) return;
      const hit = picker.pick(
        event.clientX,
        event.clientY,
        el.getBoundingClientRect(),
        camera,
        index,
        clip,
        { touch },
      );
      runtime.lastPick = hit;

      // While the place tool owns the button, a click is aiming, not picking. Without this the
      // same click both positioned the thing and re-selected whatever surface was under it, so
      // saving left the wall selected instead of the equipment just placed.
      const state = runtime.store.getState();
      if (state.tool === "place" && !state.cameraOverride && state.editing !== null) return;

      runtime.select(selectionOf(hit, state.selection));
    };

    const onDoubleClick = () => {
      void runtime.camera?.frameSelection();
    };

    const onPointerLeave = () => runtime.store.getState().setHover(null);

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("dblclick", onDoubleClick);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("dblclick", onDoubleClick);
    };
  }, [runtime, gl, camera, touch]);

  useSceneSync();
  useEquipmentLights();
  useDetectionGuide();
  // The scene's own chrome colours (selection, markers, routes) follow the theme.
  usePaletteSync();

  // ---- the test hook, gated at build time -----------------------------
  useEffect(() => installTestHook(runtime, camera), [runtime, camera]);

  // The overview preset is applied once the shell is in; keeping it here documents the contract
  // that `interactive` implies "colours applied and the overview pose set".
  useEffect(() => {
    if (phase === "interactive") runtime.invalidate();
  }, [phase, runtime]);

  return null;
}

export { OVERVIEW_PRESET };

function selectionOf(
  hit: { surfaceId: string | null; roomId: string | null; elementId: string | null } | null,
  current: Selection | null,
): Selection | null {
  if (!hit) return null;
  // Clicking a room's face selects the room; clicking it again drills into the surface.
  if (hit.roomId && !(current?.kind === "room" && current.id === hit.roomId))
    return { kind: "room", id: hit.roomId };
  if (hit.surfaceId) return { kind: "surface", id: hit.surfaceId };
  if (hit.elementId) return { kind: "element", id: hit.elementId };
  return null;
}

function hoverSelectionOf(
  hit: { surfaceId: string | null; roomId: string | null } | null,
): Selection | null {
  if (!hit) return null;
  if (hit.surfaceId) return { kind: "surface", id: hit.surfaceId };
  if (hit.roomId) return { kind: "room", id: hit.roomId };
  return null;
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id;
}
