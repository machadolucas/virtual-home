"use client";
/* eslint-disable react-hooks/immutability -- This component owns the imperative Three light and shadow camera. */
import { useEffect, useMemo, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useHouseStore } from "../hooks/useHouseStore";
import { solarPosition, daylightAppearance } from "../model/daylight";

/** One bounded site shadow map, refreshed by the existing demand-driven occluder invalidations. */
export function Lighting() {
  const settings = useHouseStore((s) => s.illumination);
  const manifest = useHouseStore((s) => s.index?.manifest);
  const performance = useHouseStore((s) => s.performanceMode);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const [now, setNow] = useState(() => Date.now());
  const sun = useMemo(() => new THREE.DirectionalLight(), []);
  const latitude = settings.latitude ?? manifest?.coordinateSystem.geoAnchor?.lat;
  const longitude = settings.longitude ?? manifest?.coordinateSystem.geoAnchor?.lon;
  const located = latitude !== undefined && longitude !== undefined && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  const studio = settings.mode === "studio" || !located;

  useEffect(() => {
    if (studio || settings.mode !== "live") return;
    // No continuous animation loop: live daylight advances once per minute.
    const refresh = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => { clearTimeout(refresh); clearInterval(timer); };
  }, [studio, settings.mode]);

  const solar = solarPosition(settings.mode === "manual" ? settings.atMs ?? now : now, located ? latitude! : 0, located ? longitude! : 0, settings.northDeg ?? manifest?.coordinateSystem.north?.bearingDeg ?? 0);
  const appearance = daylightAppearance(solar.elevationDeg);
  const direction = studio ? new THREE.Vector3(12, 20, -8).normalize() : new THREE.Vector3(...solar.direction);
  if (!studio && solar.elevationDeg < 0) {
    // An illustrative moonlit fill, not a lunar ephemeris. Never illuminate from below the ground.
    direction.set(-direction.x, Math.max(0.3, -direction.y), -direction.z).normalize();
  }
  const dx = direction.x, dy = direction.y, dz = direction.z;
  const intensity = (studio ? 1.1 : appearance.sunIntensity + appearance.nightFillIntensity) * settings.intensity;
  const color = studio ? "#ffffff" : solar.elevationDeg < 0 ? "#91a9e8" : appearance.sunColor;

  useEffect(() => {
    const bounds = manifest?.bounds ?? { min: [-10, 0, -10], max: [10, 10, 10] };
    const centre = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.max)).multiplyScalar(0.5);
    // Fit the site, including tall/exploded buildings, without ever creating an unbounded map.
    const radius = Math.max(10, new THREE.Vector3(...bounds.max).distanceTo(new THREE.Vector3(...bounds.min)) * 0.65);
    sun.name = "vh-daylight";
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(new THREE.Vector3(dx, dy, dz), radius * 2);
    sun.intensity = intensity;
    sun.color.set(color);
    sun.castShadow = true;
    const camera = sun.shadow.camera;
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.near = 0.1;
    camera.far = radius * 4;
    camera.updateProjectionMatrix();
    const size = performance ? 512 : 2048;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      sun.shadow.mapSize.set(size, size);
    }
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = settings.softShadows ? 3 : 0;
    sun.shadow.needsUpdate = true;
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [sun, manifest, dx, dy, dz, intensity, color, performance, settings.softShadows, gl, invalidate]);

  useEffect(() => () => sun.dispose(), [sun]);
  return (
    <>
      <hemisphereLight args={[studio ? "#ffffff" : appearance.skyColor, studio ? "#88806a" : appearance.groundColor, (studio ? 0.8 : appearance.ambientIntensity) * settings.intensity]} />
      <primitive object={sun} />
      <primitive object={sun.target} />
      {studio && <directionalLight position={[-10, 8, 12]} intensity={0.3 * settings.intensity} />}
    </>
  );
}
