"use client";
/**
 * The snap indicator: a small grid patch, the wall frame outline, and the snapped point as a ring,
 * plus a numeric readout. It exists so a drag never has to be trusted blind.
 */
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { SnapIndicatorState } from "@/house/scene/snap";
import { useHouseRuntime } from "../../hooks/useHouseStore";
import { useViewerPalette } from "../../hooks/useViewerPalette";

/**
 * The in-canvas half of the indicator. The editor panel lives outside `<Canvas>`, so the state
 * travels through the runtime's listener channel rather than through React state: a drag writes
 * one field and re-renders exactly this component, never the workspace.
 */
export function SnapIndicatorLayer() {
  const runtime = useHouseRuntime();
  const [state, setState] = useState<SnapIndicatorState | null>(runtime.snapIndicator);
  useEffect(() => runtime.onSnapIndicator(setState), [runtime]);
  useEffect(() => {
    runtime.invalidate();
  }, [runtime, state]);
  return <SnapIndicator state={state} />;
}

export function SnapIndicator({ state }: { state: SnapIndicatorState | null }) {
  const gridGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1, 10, 10), []);
  const ringGeometry = useMemo(() => new THREE.RingGeometry(0.06, 0.08, 24), []);
  useEffect(() => () => { gridGeometry.dispose(); ringGeometry.dispose(); }, [gridGeometry, ringGeometry]);
  // Hooks before the early return: the indicator only exists during a drag, but a theme change
  // while dragging still has to re-tint it.
  const snapColor = useViewerPalette().snap;
  if (!state) return null;

  const offset = 0;
  const [x, y, z] = state.point;

  return (
    <group name="vh-snap-indicator" position={[0, offset, 0]}>
      {state.kind !== "wall" ? (
        <lineSegments position={[x, (state.floorY ?? y) + 0.002, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <wireframeGeometry args={[gridGeometry]} />
          <lineBasicMaterial color={snapColor} transparent opacity={0.5} depthTest={false} />
        </lineSegments>
      ) : null}

      {state.kind === "wall" && state.frame ? (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[wallOutline(state), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={snapColor} transparent opacity={0.6} depthTest={false} />
        </lineSegments>
      ) : null}

      <mesh geometry={ringGeometry} position={[x, y + 0.003, z]} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial color={snapColor} transparent opacity={0.9} depthTest={false} side={THREE.DoubleSide} />
      </mesh>
      {state.ground && y - state.ground.point[1] > 0.05 ? (
        <ElevationGuide point={state.point} groundY={state.ground.point[1]} color={snapColor} />
      ) : null}
    </group>
  );
}

/** Dashed segments avoid a frame loop or a line-distance buffer update on hover. */
function ElevationGuide({ point: [x, y, z], groundY, color }: {
  point: readonly [number, number, number]; groundY: number; color: string | number;
}) {
  const vertices = useMemo(() => {
    const lines: number[] = [];
    for (let h = groundY; h < y; h += 0.12) lines.push(x, h, z, x, Math.min(h + 0.065, y), z);
    return new Float32Array(lines);
  }, [x, y, z, groundY]);
  return (
    <group name="vh-elevation-guide">
      <lineSegments renderOrder={10}>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[vertices, 3]} /></bufferGeometry>
        <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.8} />
      </lineSegments>
      <mesh position={[x, groundY + 0.005, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
        <ringGeometry args={[0.09, 0.12, 32]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.65} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** The wall face rectangle in world space, as a closed line loop. */
function wallOutline(state: SnapIndicatorState): Float32Array {
  const frame = state.frame;
  if (!frame) return new Float32Array(0);
  const corners = [
    frame.toWorld(frame.uRange[0], frame.vRange[0], 0.005),
    frame.toWorld(frame.uRange[1], frame.vRange[0], 0.005),
    frame.toWorld(frame.uRange[1], frame.vRange[1], 0.005),
    frame.toWorld(frame.uRange[0], frame.vRange[1], 0.005),
  ];
  const out: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i] as THREE.Vector3;
    const b = corners[(i + 1) % corners.length] as THREE.Vector3;
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  return new Float32Array(out);
}

/**
 * The readout, over the canvas rather than in the inspector panel.
 *
 * It used to render inside the editor panel, whose `absolute` positioning put it in the corner of
 * the right sidebar — metres away from the cursor it describes, and easy to miss entirely. Like
 * the 3D indicator it reads the runtime channel, so a hover updates it without re-rendering the
 * workspace.
 */
export function SnapReadoutOverlay() {
  const runtime = useHouseRuntime();
  const [state, setState] = useState<SnapIndicatorState | null>(runtime.snapIndicator);
  useEffect(() => runtime.onSnapIndicator(setState), [runtime]);
  return <SnapReadout state={state} />;
}

export function SnapReadout({ state }: { state: SnapIndicatorState | null }) {
  if (!state) return null;
  const [x, y, z] = state.point;
  return (
    <p className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-line bg-surface/85 text-ink shadow-pop backdrop-blur-sm px-2 py-1 font-mono text-[11px]">
      {state.kind === "wall" && state.u !== undefined && state.v !== undefined
        ? `along wall ${state.u.toFixed(3)} m · height ${state.v.toFixed(3)} m`
        : `x ${x.toFixed(3)} · y ${y.toFixed(3)} · z ${z.toFixed(3)}`}
      {state.ground && y - state.ground.point[1] > 0.05
        ? ` · ${(y - state.ground.point[1]).toFixed(2)} m above ${state.ground.label}${state.ground.source === "floor-datum" ? " (reference)" : ""}`
        : null}
    </p>
  );
}
