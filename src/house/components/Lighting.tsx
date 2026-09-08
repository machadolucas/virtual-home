"use client";
/**
 * The lighting recipe from the validated reference renders. No shadows, no HDRI.
 *
 * Shadows are off deliberately: a shadow pass would roughly double the draw calls, a single
 * directional light over a 41 × 23 m site needs either a useless-at-room-scale ortho shadow camera
 * or CSM, and the point of the view is interior legibility, where a shadow across a floor actively
 * hurts. Depth is carried by the package's own `edges-*` overlays and the per-surface colours.
 *
 * No `<Environment>`: an IBL is nearly indistinguishable from a hemisphere light when every
 * material is `metalness: 0, roughness: 0.9`, and it would cost 1–2 MB plus a PMREM pass.
 */
export function Lighting() {
  return (
    <>
      <hemisphereLight args={[0xffffff, 0x88806a, 1.1]} />
      {/* key, from plan-north-east */}
      <directionalLight position={[12, 20, -8]} intensity={1.6} />
      {/* fill, from plan-south-west */}
      <directionalLight position={[-10, 8, 12]} intensity={0.5} />
    </>
  );
}
