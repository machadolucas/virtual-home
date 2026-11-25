import * as THREE from "three";
import type { SceneIndex } from "../scene/SceneIndex";

import { FrameLog, type FrameArea } from "./frameLog";

function grainTexture() {
  const size = 64,
    bytes = new Uint8Array(size * size * 4);
  let seed = 101;
  for (let i = 0; i < bytes.length; i += 4) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    bytes.fill(seed >>> 24, i, i + 3);
    bytes[i + 3] = 255;
  }
  const map = new THREE.DataTexture(bytes, size, size);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipMapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

/** VR-only detail shaders retain the authored material colour and texture inputs. */
export class WalkAppearance {
  private grain = grainTexture();
  private readonly horizon = new THREE.Color().setRGB(0.65, 0.75, 0.79);
  private readonly zenith = new THREE.Color().setRGB(0.18, 0.38, 0.58);
  private nextSkySample = -Infinity;
  private materials = new Map<
    THREE.Mesh,
    { original: THREE.MeshStandardMaterial; vr: THREE.MeshStandardMaterial }
  >();
  readonly sky = new THREE.Mesh(
    new THREE.SphereGeometry(220, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { vhHorizon: { value: this.horizon }, vhZenith: { value: this.zenith } },
      vertexShader:
        "varying float altitude; void main(){altitude=normalize(position).y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader: `varying float altitude; uniform vec3 vhHorizon; uniform vec3 vhZenith;
    void main(){gl_FragColor=vec4(mix(vhHorizon,vhZenith,smoothstep(-.04,.86,altitude)),1.);
    #include <colorspace_fragment>
    }`,
    }),
  );
  constructor(index: SceneIndex) {
    this.sky.renderOrder = -500;
    this.sky.frustumCulled = false;
    for (const [sid, mesh] of index.surfaceMesh) {
      const surface = index.manifest.surfaces.get(sid);
      const role = surface?.role;
      const owner = surface?.elementId ? index.manifest.elements.get(surface.elementId)?.kind : undefined;
      const m = mesh.material;
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      const grain = !m.map && (role === "paving" || role === "ground") ? role : null;
      const contrast = role === "door-threshold" ? "1.14"
        : role === "door-frame" || role === "door-jamb" || (role === "reveal" && (owner === "door" || owner === "opening"))
          ? "0.90" : null;
      if (!grain && !contrast) continue;
      const vr = m.clone();
      vr.onBeforeCompile = (shader, renderer) => {
        m.onBeforeCompile(shader, renderer);
        if (contrast) {
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            `#include <color_fragment>\ndiffuseColor.rgb *= ${contrast};`,
          );
          return;
        }
        shader.uniforms.vhGrain = { value: this.grain };
        shader.vertexShader =
          "varying vec2 vhPlan;\n" +
          shader.vertexShader.replace(
            "#include <project_vertex>",
            "#include <project_vertex>\nvhPlan = (modelMatrix*vec4(transformed,1.)).xz;",
          );
        shader.fragmentShader =
          "uniform sampler2D vhGrain; varying vec2 vhPlan;\n" +
          shader.fragmentShader.replace(
            "#include <color_fragment>",
            `#include <color_fragment>\ndiffuseColor.rgb *= 1.0 + (texture2D(vhGrain,vhPlan*${grain === "ground" ? "1.4" : "2.8"}).r-0.5)*0.15;`,
          );
      };
      vr.customProgramCacheKey = () => `vh-xr-${grain ?? contrast}-${m.customProgramCacheKey()}`;
      this.materials.set(mesh, { original: m, vr });
      mesh.material = vr;
    }
  }

  /** Sample the scene authored by the desktop lighting component, including replaced light nodes. */
  updateSky(scene: THREE.Scene, now: number) {
    if (now < this.nextSkySample) return;
    this.nextSkySample = now + 500;
    const light = scene.children.find((child) => child instanceof THREE.HemisphereLight) ??
      scene.getObjectByProperty("isHemisphereLight", true);
    if (!(light instanceof THREE.HemisphereLight) || !light.visible) return;
    const daylight = THREE.MathUtils.smoothstep(light.intensity, 0.35, 1.08);
    this.horizon.copy(light.color).lerp(light.groundColor, 0.22).multiplyScalar(0.08 + daylight * 0.72);
    this.zenith.setRGB(light.color.r * 0.40, light.color.g * 0.70, light.color.b)
      .multiplyScalar(0.015 + daylight * 0.50);
  }
  detail(enabled: boolean) {
    for (const [mesh, { original, vr }] of this.materials) {
      vr.color.copy(original.color);
      mesh.material = enabled ? vr : original;
    }
  }
  dispose() {
    this.detail(false);
    for (const { vr } of this.materials.values()) vr.dispose();
    this.grain.dispose();
    this.sky.removeFromParent();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}

type RateSession = XRSession & {
  frameRate?: number;
  supportedFrameRates?: Float32Array;
  updateTargetFrameRate?: (hz: number) => Promise<void>;
};
export class FrameBudget {
  readonly log = new FrameLog();
  private intervals: number[] = [];
  private last = 0;
  private stable = 0;
  private slow = 0;
  private requested = 0;
  private changed = false;
  private rejected = new Set<number>();
  low = false;
  p95 = 0;
  rate = 0;
  constructor(private session: RateSession) {
    this.request(72);
  }
  private request(hz: number) {
    if (
      this.changed ||
      this.rejected.has(hz) ||
      !this.session.supportedFrameRates?.includes(hz) ||
      !this.session.updateTargetFrameRate
    )
      return;
    this.changed = true;
    void this.session
      .updateTargetFrameRate(hz)
      .then(() => {
        this.requested = hz;
      })
      .catch(() => {
        this.rejected.add(hz);
      })
      .finally(() => {
        this.changed = false;
      });
  }
  get canTry90() {
    return (
      this.stable >= 2 &&
      !this.low &&
      !!this.session.supportedFrameRates?.includes(90) &&
      !this.rejected.has(90)
    );
  }
  try90() {
    if (this.canTry90) {
      this.stable = 0;
      this.request(90);
    }
  }
  resetClock() {
    this.last = 0;
    this.intervals.length = 0;
  }
  tick(time: number, area: FrameArea) {
    const dt = time - this.last;
    if (this.last && dt > 0 && dt < 500) {
      this.intervals.push(dt);
      this.log.sample(area, dt, this.session.frameRate || this.requested || 72);
    }
    this.last = time;
    if (this.intervals.length < 120) return;
    const window = this.intervals.sort((a, b) => a - b);
    this.p95 = window[Math.floor(window.length * 0.95)]!;
    this.rate =
      this.session.frameRate || this.requested || Math.round(1000 / window[Math.floor(window.length / 2)]!);
    this.intervals = [];
    if (this.p95 > (1.35 * 1000) / Math.max(this.rate, 72)) {
      this.stable = 0;
      if (++this.slow >= 2) {
        this.low = true;
        if (this.rate > 72) this.request(72);
      }
    } else {
      this.slow = 0;
      this.stable++;
      if (this.stable >= 5) this.low = false;
    }
  }
  get label() {
    return this.p95
      ? `${this.rate} Hz · p95 ${this.p95.toFixed(1)} ms · ${this.low ? "reduced detail" : "normal detail"}`
      : "Measuring headset frame timing…";
  }
}
