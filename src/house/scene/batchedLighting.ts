import * as THREE from "three";

type LocalLight = THREE.PointLight | THREE.SpotLight;
type Drawable = THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite;
interface CachedPass { target: THREE.WebGLRenderTarget; signature: string }

/** Conservative finite-range test. Out-of-range surfaces remain depth/shadow occluders. */
export function lightReachesBox(light: LocalLight, box: THREE.Box3): boolean {
  return light.distance === 0 || box.distanceToPoint(light.getWorldPosition(new THREE.Vector3())) <= light.distance;
}

/** Stable spatial grouping; neither brightness nor the camera decides which lights are detailed. */
export function lightBatches(lights: readonly LocalLight[], size: number): LocalLight[][] {
  const ordered = [...lights].sort((a, b) => String(a.userData.vhRoom ?? "").localeCompare(String(b.userData.vhRoom ?? "")) ||
    a.position.x - b.position.x || a.position.z - b.position.z || a.uuid.localeCompare(b.uuid));
  const result: LocalLight[][] = [];
  for (let i = 0; i < ordered.length; i += Math.max(1, size)) result.push(ordered.slice(i, i + Math.max(1, size)));
  return result;
}

/** Same PBR direct-light calculation as the ordinary pass, without repeating ambient/emissive. */
export function directLightMaterial(source: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const result = source.clone();
  const originalCompile = source.onBeforeCompile;
  result.onBeforeCompile = (shader, renderer) => {
    originalCompile.call(source, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <aomap_fragment>", `#include <aomap_fragment>
      reflectedLight.indirectDiffuse = vec3(0.0);
      reflectedLight.indirectSpecular = vec3(0.0);
      totalEmissiveRadiance = vec3(0.0);`);
    // Fog's colour belongs to the base pass; additional light only receives its attenuation.
    shader.fragmentShader = shader.fragmentShader.replace("#include <fog_fragment>", `
      #ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor.rgb *= 1.0 - fogFactor;
      #endif`);
  };
  result.customProgramCacheKey = () => `vh-direct-v1:${source.customProgramCacheKey()}`;
  return result;
}

function darkMaterial(source: THREE.Material): THREE.Material {
  if (source instanceof THREE.ShaderMaterial) {
    const result = source.clone();
    result.uniforms = source.uniforms;
    result.onBeforeCompile = (shader, renderer) => {
      source.onBeforeCompile(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(/void\s+main\s*\(\s*\)\s*\{/, "void vhUnlitMain() {") +
        "\nvoid main() { vhUnlitMain(); gl_FragColor.rgb = vec3(0.0); }";
    };
    result.customProgramCacheKey = () => `vh-dark-v1:${source.customProgramCacheKey()}`;
    return result;
  }
  // Retain texture alpha, clipping and sidedness, so an unlit foreground surface still occludes.
  const textured = source as THREE.MeshStandardMaterial;
  const result = new THREE.MeshBasicMaterial({ color: 0, map: textured.map ?? null,
    alphaMap: textured.alphaMap ?? null, alphaTest: source.alphaTest, opacity: source.opacity,
    transparent: source.transparent, side: source.side, depthTest: source.depthTest,
    depthWrite: source.depthWrite, blending: source.blending, vertexColors: false });
  result.clippingPlanes = source.clippingPlanes;
  result.clipIntersection = source.clipIntersection;
  result.clipShadows = source.clipShadows;
  result.polygonOffset = source.polygonOffset;
  result.polygonOffsetFactor = source.polygonOffsetFactor;
  result.polygonOffsetUnits = source.polygonOffsetUnits;
  result.visible = source.visible;
  return result;
}

function positionVersion(mesh: THREE.Mesh): number | undefined {
  const p = mesh.geometry?.attributes.position;
  return p instanceof THREE.InterleavedBufferAttribute ? p.data.version : p?.version;
}

function uniformKey(value: unknown): unknown {
  if (value instanceof THREE.Texture) return [value.uuid, value.version];
  if (value instanceof THREE.Matrix3 || value instanceof THREE.Matrix4) return value.elements;
  if (value instanceof THREE.Color) return value.toArray();
  if (value instanceof THREE.Vector2) return value.toArray();
  if (value instanceof THREE.Vector3) return value.toArray();
  if (value instanceof THREE.Vector4) return value.toArray();
  if (Array.isArray(value)) return value.map(uniformKey);
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null;
}

function materialKey(material: THREE.Material): string {
  for (const value of Object.values(material)) if (value instanceof THREE.Texture && value.matrixAutoUpdate) value.updateMatrix();
  const m = material as THREE.MeshStandardMaterial;
  return JSON.stringify([m.uuid, m.version, m.visible, m.opacity, m.transparent, m.side, m.depthWrite,
    Object.entries(m).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || typeof v === "string" ||
      v instanceof THREE.Color || v instanceof THREE.Vector2).map(([k, v]) => [k, uniformKey(v)]),
    m instanceof THREE.ShaderMaterial ? Object.entries(m.uniforms).map(([key, u]) => [key, uniformKey(u.value)]) : null,
    m.clippingPlanes?.map(p => [...p.normal.toArray(), p.constant]), m.clipIntersection,
    Object.values(m).filter(v => v instanceof THREE.Texture).map(t => [t.uuid, t.version, t.matrix.elements])]);
}

/** Full-resolution linear-light passes. View-dependent caching preserves PBR instead of baking
 * out reflections. Memory caps evict cached passes, never lower their resolution or skip lights. */
export class BatchedLighting {
  private readonly originalRender: THREE.WebGLRenderer["render"];
  private readonly originalBound: THREE.WebGLRenderer["render"];
  private readonly passes = new Map<string, CachedPass>();
  private readonly materials = new Map<THREE.Material, { key: string; direct: THREE.Material; dark: THREE.Material }>();
  private readonly accumulation = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly scratch = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly copy = new THREE.ShaderMaterial({
    uniforms: { image: { value: null } }, depthTest: false, depthWrite: false,
    vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}",
    fragmentShader: "uniform sampler2D image; varying vec2 vUv; void main(){gl_FragColor=texture2D(image,vUv); #include <colorspace_fragment>\n}",
  });
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copy);
  private frameSize = "";
  private shadowGeometry = "";
  private running = false;
  readonly stats = { rendered: 0, reused: 0, batches: 0, litSurfaces: 0, unlitSurfaces: 0 };

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene,
    private readonly settings: () => { enabled: boolean; size: number; lights: readonly LocalLight[] }) {
    this.scratch.samples = renderer.getContext().getContextAttributes()?.antialias ? Math.min(4, renderer.capabilities.maxSamples) : 0;
    this.originalRender = renderer.render;
    this.originalBound = renderer.render.bind(renderer);
    this.copy.fragmentShader = this.copy.fragmentShader.replace("; #include", ";\n#include");
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    renderer.render = (scene, camera) => {
      const config = settings();
      if (this.running || scene !== this.scene || !config.enabled || !config.lights.length ||
          !renderer.extensions.has("EXT_color_buffer_float")) {
        if (!config.enabled || !config.lights.length) this.suspend();
        this.originalBound(scene, camera); return;
      }
      this.render(camera, config);
    };
  }

  private render(camera: THREE.Camera, config: ReturnType<BatchedLighting["settings"]>): void {
    const gl = this.renderer;
    const output = gl.getRenderTarget();
    const size = output ? new THREE.Vector2(output.width, output.height) : gl.getDrawingBufferSize(new THREE.Vector2());
    const key = `${size.x}:${size.y}`;
    if (this.frameSize !== key) {
      this.releasePasses();
      this.accumulation.setSize(size.x, size.y);
      this.scratch.setSize(size.x, size.y);
      this.frameSize = key;
    }
    this.running = true;
    const previous = { autoClear: gl.autoClear, color: gl.getClearColor(new THREE.Color()), alpha: gl.getClearAlpha(),
      viewport: gl.getViewport(new THREE.Vector4()), scissor: gl.getScissor(new THREE.Vector4()), scissorTest: gl.getScissorTest(),
      background: this.scene.background, environment: this.scene.environment, autoReset: gl.info.autoReset };
    const drawables: { object: Drawable; material: THREE.Material | THREE.Material[]; box: THREE.Box3 }[] = [];
    const lights: { light: THREE.Light; visible: boolean }[] = [];
    const geometry: unknown[] = [];
    const depthGeometry: unknown[] = [];
    const usedMaterials = new Set<THREE.Material>();
    this.scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const local = new Set<THREE.Light>(config.lights);
    this.scene.traverseVisible(object => {
      if (object instanceof THREE.Light) lights.push({ light: object, visible: object.visible });
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite)) return;
      const list: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material];
      const keys = list.map(m => {
        usedMaterials.add(m);
        const key = materialKey(m);
        const cached = this.materials.get(m);
        if (!cached || cached.key !== key) {
          cached?.direct.dispose(); cached?.dark.dispose();
          this.materials.set(m, { key, direct: m instanceof THREE.MeshStandardMaterial ? directLightMaterial(m) : darkMaterial(m), dark: darkMaterial(m) });
        }
        return key;
      });
      const isCore = object.name === "vh-live-emitting-cores";
      // Cores are an unlit overlay, never an occluder for another light's cached contribution.
      if (isCore) return;
      const mesh = object as THREE.Mesh;
      if (object.castShadow) depthGeometry.push([object.uuid, object.matrixWorld.elements, object.layers.mask, mesh.geometry?.uuid,
        positionVersion(mesh), mesh.geometry?.index?.version, mesh.geometry?.drawRange,
        mesh instanceof THREE.InstancedMesh ? [mesh.count, mesh.instanceMatrix.version] : null,
        list.map(m => {
          const source = m as THREE.MeshStandardMaterial;
          return [m.opacity, m.alphaTest, m.alphaHash, m.alphaToCoverage, m.side, m.shadowSide, m.visible,
            [source.alphaMap, source.map, source.displacementMap].map(t => t ? [t.uuid, t.version, t.matrix.elements] : null),
            source.displacementScale, source.displacementBias,
            m.clipShadows ? m.clippingPlanes?.map(p => [...p.normal.toArray(), p.constant]) : null];
        })]);
      geometry.push([object.uuid, object.matrixWorld.elements, object.layers.mask, keys, mesh.geometry?.uuid,
        Object.entries(mesh.geometry?.attributes ?? {}).map(([name, attr]) => [name, attr instanceof THREE.InterleavedBufferAttribute ? attr.data.version : attr.version]),
        mesh.geometry?.index?.version, mesh.geometry?.drawRange,
        mesh instanceof THREE.InstancedMesh ? [mesh.count, mesh.instanceMatrix.version, mesh.instanceColor?.version] : null]);
      if (object instanceof THREE.InstancedMesh) object.computeBoundingBox();
      drawables.push({ object, material: object.material, box: new THREE.Box3().setFromObject(object) });
    });
    const depthKey = JSON.stringify(depthGeometry);
    if (depthKey !== this.shadowGeometry) {
      for (const light of config.lights) light.shadow.needsUpdate = true;
      this.shadowGeometry = depthKey;
    }
    const geometryKey = JSON.stringify([geometry, camera.matrixWorld.elements, camera.projectionMatrix.elements, camera.layers.mask, key, gl.clippingPlanes.map(p => [...p.normal.toArray(), p.constant])]);
    const batches = lightBatches(config.lights, config.size);
    this.stats.batches = batches.length;
    const activeIds = new Set(batches.map(batch => batch.map(light => light.uuid).join(":")));
    for (const [id, pass] of this.passes) if (!activeIds.has(id)) { pass.target.dispose(); this.passes.delete(id); }
    const needed = new Set<string>();
    // About 96 MiB for cached colour. Large canvases stream batches through one scratch target.
    const cacheCount = Math.max(0, Math.floor(96 * 1024 * 1024 / (size.x * size.y * 8)));
    try {
      gl.info.autoReset = false;
      if (previous.autoReset) gl.info.reset();
      gl.autoClear = true;
      gl.setScissorTest(false);
      for (const { light } of lights) if (local.has(light)) light.visible = false;
      gl.setRenderTarget(this.scratch);
      this.originalBound(this.scene, camera);
      gl.setRenderTarget(this.accumulation);
      this.copy.blending = THREE.NoBlending;
      this.copy.uniforms.image!.value = this.scratch.texture;
      this.originalBound(this.quadScene, this.quadCamera);
      this.scene.background = null;
      this.scene.environment = null;
      gl.setClearColor(0, 0);
      for (const { light } of lights) light.visible = false;
      const cores = this.scene.getObjectByName("vh-live-emitting-cores");
      const coresVisible = cores?.visible ?? false;
      if (cores) cores.visible = false;
      try {
        for (const batch of batches) {
          if (!batch.some(light => light.intensity > 0)) continue;
          const id = batch.map(light => light.uuid).join(":");
          const signature = JSON.stringify([geometryKey, batch.map(light => [light.uuid, light.matrixWorld.elements,
            light.color.toArray(), light.intensity, light.distance, light.decay, light.shadow.radius,
            light instanceof THREE.SpotLight ? [light.angle, light.penumbra, light.target.matrixWorld.elements] : null])]);
          let cached = this.passes.get(id);
          if (!cached && needed.size < cacheCount) {
            cached = { target: new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: false }), signature: "" };
            this.passes.set(id, cached);
          }
          if (cached) needed.add(id);
          const target = cached?.target ?? this.scratch;
          const dirtyShadow = batch.some(light => light.shadow.needsUpdate);
          if (!cached || cached.signature !== signature || dirtyShadow) {
            for (const light of batch) light.visible = true;
            const ranges = batch.filter(light => light.intensity > 0).map(light => ({
              center: light.getWorldPosition(new THREE.Vector3()), distance: light.distance,
            }));
            for (const { object, material, box } of drawables) {
              const reaches = ranges.some(light => light.distance === 0 || box.distanceToPoint(light.center) <= light.distance);
              if (reaches) this.stats.litSurfaces++; else this.stats.unlitSurfaces++;
              const replace = (m: THREE.Material) => this.materials.get(m)![reaches ? "direct" : "dark"];
              object.material = Array.isArray(material) ? material.map(replace) : replace(material);
            }
            gl.shadowMap.needsUpdate = dirtyShadow;
            gl.setRenderTarget(this.scratch);
            gl.autoClear = true;
            this.originalBound(this.scene, camera);
            this.stats.rendered++;
            if (cached) {
              gl.setRenderTarget(cached.target);
              this.copy.blending = THREE.NoBlending;
              this.copy.uniforms.image!.value = this.scratch.texture;
              this.originalBound(this.quadScene, this.quadCamera);
              cached.signature = signature;
            }
            for (const light of batch) light.visible = false;
          } else this.stats.reused++;
          gl.setRenderTarget(this.accumulation);
          gl.autoClear = false;
          this.copy.uniforms.image!.value = target.texture;
          this.copy.blending = THREE.CustomBlending;
          this.copy.blendSrc = THREE.OneFactor;
          this.copy.blendDst = THREE.OneFactor;
          this.copy.blendSrcAlpha = THREE.ZeroFactor;
          this.copy.blendDstAlpha = THREE.OneFactor;
          this.originalBound(this.quadScene, this.quadCamera);
        }
      } finally { if (cores) cores.visible = coresVisible; }
      gl.setRenderTarget(output);
      gl.setViewport(previous.viewport);
      gl.setScissor(previous.scissor);
      gl.setScissorTest(previous.scissorTest);
      gl.autoClear = true;
      this.copy.blending = THREE.NoBlending;
      this.copy.uniforms.image!.value = this.accumulation.texture;
      this.originalBound(this.quadScene, this.quadCamera);
    } finally {
      for (const { object, material } of drawables) object.material = material;
      for (const { light, visible } of lights) light.visible = visible;
      this.scene.background = previous.background;
      this.scene.environment = previous.environment;
      gl.setClearColor(previous.color, previous.alpha);
      gl.setRenderTarget(output);
      gl.setViewport(previous.viewport); gl.setScissor(previous.scissor); gl.setScissorTest(previous.scissorTest);
      gl.autoClear = previous.autoClear; gl.info.autoReset = previous.autoReset;
      this.running = false;
      for (const [id, pass] of this.passes) if (!needed.has(id)) { pass.target.dispose(); this.passes.delete(id); }
      for (const [source, pair] of this.materials) if (!usedMaterials.has(source)) {
        pair.direct.dispose(); pair.dark.dispose(); this.materials.delete(source);
      }
    }
  }

  private suspend(): void {
    this.releasePasses();
    for (const pair of this.materials.values()) { pair.direct.dispose(); pair.dark.dispose(); }
    this.materials.clear();
    if (this.frameSize) {
      this.accumulation.dispose(); this.scratch.dispose(); this.frameSize = "";
    }
  }

  private releasePasses(): void {
    for (const pass of this.passes.values()) pass.target.dispose();
    this.passes.clear();
  }

  dispose(): void {
    this.renderer.render = this.originalRender;
    this.releasePasses();
    for (const pair of this.materials.values()) { pair.direct.dispose(); pair.dark.dispose(); }
    this.materials.clear();
    this.accumulation.dispose(); this.scratch.dispose(); this.copy.dispose(); this.quad.geometry.dispose();
  }
}
