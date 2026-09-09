"use client";
/**
 * The `<Canvas>` and everything inside it.
 *
 * `frameloop="demand"`: nothing renders unless something asks. Every trigger that must ask is
 * listed in `docs/model-contract.md`; label text, badge classes and inspector renders deliberately
 * do **not** (a temperature reading must not wake the GPU).
 *
 * `localClippingEnabled` is required for per-material `clippingPlanes`; `NoToneMapping` keeps
 * persisted hex colours literal (ACES would shift the pale surfaces so the saved colour would not
 * match what the user picked).
 *
 * The **background is CSS on the host div**, not a scene colour or texture: `alpha: true`,
 * `scene.background = null` and a zero clear alpha let whatever the host paints — a token, a solid
 * colour or a gradient — show through the render. That is why a user gradient needs no shader and no
 * extra draw call; `docs/decisions.md` records the trade (a transparent drawing buffer, which costs
 * one blend against the page).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { backgroundStyle, DEFAULT_HOUSE_BACKGROUND, type HouseBackground } from "@/house/model/background";
import { useHouseStore } from "../hooks/useHouseStore";
import { useIsPhone } from "../hooks/useReducedMotion";
import { LabelHost, LabelProjector, useLabelAnchors } from "./LabelOverlay";
import { CaptureBridge } from "./CaptureBridge";
import { Lighting } from "./Lighting";
import { MarkerButtons, MarkerDomLayer } from "./MarkerLayer";
import { Rig } from "./Rig";
import { RoutePointHandles } from "./RouteLayer";
import { SceneRoot } from "./SceneRoot";
import { SnapIndicatorLayer } from "./edit/SnapIndicator";

export interface HouseCanvasProps {
  /**
   * The household's background choice. Passed from the server through the workspace so the first
   * paint is already right — a default painted for one frame and then replaced is a flash.
   */
  background?: HouseBackground;
}

export function HouseCanvas({ background = DEFAULT_HOUSE_BACKGROUND }: HouseCanvasProps = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const markerHostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const anchors = useLabelAnchors();
  const phone = useIsPhone();
  const performanceMode = useHouseStore((s) => s.performanceMode);
  const dpr = usePixelRatioCap(canvasHostRef, { phone, performanceMode });

  // One `invalidate()` per background change. Nothing in the scene depends on the background, so
  // this is only about the compositor: the transparent buffer has to be re-blended over the new
  // CSS paint, and under `frameloop="demand"` nobody else would ask.
  const invalidateRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    invalidateRef.current?.();
  }, [background]);

  return (
    <div
      ref={canvasHostRef}
      data-testid="vh-canvas-host"
      className="relative h-full w-full overflow-hidden rounded-lg bg-viewport"
      style={backgroundStyle(background)}
    >
      <Canvas
        frameloop="demand"
        dpr={dpr}
        gl={{
          antialias: true,
          // Transparent so the host div's CSS background (token, solid or gradient) shows through.
          alpha: true,
          powerPreference: "high-performance",
          stencil: false,
          depth: true,
          preserveDrawingBuffer: false,
          failIfMajorPerformanceCaveat: false,
        }}
        onCreated={({ gl, scene, invalidate }) => {
          gl.localClippingEnabled = true;
          gl.toneMapping = THREE.NoToneMapping;
          gl.setClearAlpha(0);
          scene.background = null;
          invalidateRef.current = invalidate;
        }}
        // Cameras are mounted explicitly in <Rig/> so the projection switch is under our control.
        camera={undefined}
        className="!absolute !inset-0"
      >
        <Lighting />
        <Rig />
        <SceneRoot />
        <RoutePointHandles />
        <SnapIndicatorLayer />
        <LabelProjector hostRef={hostRef} anchors={anchors} />
        <MarkerDomLayer hostRef={markerHostRef} />
        <CaptureBridge hostRef={canvasHostRef} labelRef={hostRef} />
      </Canvas>
      <MarkerButtons hostRef={markerHostRef} />
      <LabelHost hostRef={hostRef} anchors={anchors} />
    </div>
  );
}

/**
 * Pixel-ratio policy: cap at 2, dropping to 1.5 above ~1.6 Mpx of canvas area, 1.5 on a phone and
 * 1 in performance mode. A `ResizeObserver` recomputes it; under `frameloop="demand"` a dpr change
 * costs one re-render, not a loop.
 */
function usePixelRatioCap(
  hostRef: React.RefObject<HTMLDivElement | null>,
  opts: { phone: boolean; performanceMode: boolean },
): [number, number] {
  const [cap, setCap] = useState(2);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setCap(rect.width * rect.height > 1_600_000 ? 1.5 : 2);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);

  return useMemo(() => {
    if (opts.performanceMode) return [1, 1];
    if (opts.phone) return [1, Math.min(cap, 1.5)];
    return [1, cap];
  }, [cap, opts.performanceMode, opts.phone]);
}
