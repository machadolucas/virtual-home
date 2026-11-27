import * as THREE from "three";
import type { AlignmentEvidence } from "./roomAlignmentEvidence";

const MAX_EDGES = 384;
const STALE_MS = 1500;
const up = new THREE.Vector3(0, 1, 0);

export function scanSummary(evidence: AlignmentEvidence | null, unavailable: boolean) {
  if (unavailable) return "Room scan access unavailable";
  if (!evidence || !(evidence.patches.length || evidence.triangles.length)) return "No room surfaces received";
  const walls = evidence.walls.length;
  return `${evidence.floor ? "Floor found" : "No floor under you"} · ${walls} ${walls === 1 ? "wall" : "walls"}`;
}

/** Local tracking space only. Edges come directly from native polygons or sampled mesh triangles. */
export class ScanFeedback {
  readonly group = new THREE.Group();
  private readonly edges = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x75ceff, toneMapped: false }),
    MAX_EDGES,
  );
  private readonly segment = new THREE.Object3D();
  private readonly direction = new THREE.Vector3();
  private readonly destination = new THREE.Vector3();
  private readonly view = new THREE.Quaternion();
  private badge: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private observedAt = -Infinity;
  private message = "";
  private drawn = "";

  constructor() {
    this.group.name = "vh-room-scan-feedback";
    this.group.visible = false;
    this.edges.name = "vh-measured-surfaces";
    this.edges.count = 0;
    this.edges.frustumCulled = false;
    this.edges.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.edges);
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 106;
    this.context = canvas.getContext("2d");
    if (!this.context) return;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    this.badge = new THREE.Mesh(new THREE.PlaneGeometry(.49, .081),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
    this.badge.name = "vh-room-scan-status";
    this.badge.renderOrder = 999;
    this.group.add(this.badge);
  }

  observe(evidence: AlignmentEvidence, now: number) {
    this.observedAt = now;
    this.message = scanSummary(evidence, false);
    this.edges.count = 0;
    const addEdge = (a: THREE.Vector3, b: THREE.Vector3) => {
      if (this.edges.count >= MAX_EDGES) return;
      this.direction.subVectors(b, a);
      const length = this.direction.length();
      if (length < .025) return;
      this.segment.position.copy(a).lerp(b, .5);
      this.segment.scale.set(.012, length, .012);
      this.segment.quaternion.setFromUnitVectors(up, this.direction.divideScalar(length));
      this.segment.updateMatrix();
      this.edges.setMatrixAt(this.edges.count++, this.segment.matrix);
    };
    for (const { boundary } of evidence.patches) {
      for (let i = 0; i < boundary.length; i++) addEdge(boundary[i]!, boundary[(i + 1) % boundary.length]!);
      if (this.edges.count >= MAX_EDGES) break;
    }
    if (!this.edges.count) {
      // Sample the actual triangles. A mesh hull could draw across doors and concave floor recesses.
      const triangles = evidence.triangles;
      const stride = Math.max(1, Math.ceil(triangles.length / 72));
      for (let i = 0; i < triangles.length; i += stride) {
        const [a, b, c] = triangles[i]!;
        addEdge(a, b); addEdge(b, c); addEdge(c, a);
      }
    }
    this.edges.instanceMatrix.needsUpdate = true;
  }

  summary(now: number, unavailable: boolean) {
    return !unavailable && now - this.observedAt <= STALE_MS ? this.message : scanSummary(null, unavailable);
  }

  frame(pose: XRViewerPose | null, now: number, dt: number, unavailable: boolean, checking: boolean, fallback: string,
    traceStatus?: { title: string; instruction: string }) {
    if (!pose || pose.emulatedPosition) { this.clear(); return; }
    const fresh = now - this.observedAt <= STALE_MS;
    this.edges.visible = !traceStatus && fresh && !unavailable && this.edges.count > 0;
    const title = traceStatus?.title ?? this.summary(now, unavailable);
    const subtitle = traceStatus?.instruction ?? (this.edges.visible ? checking ? "Comparing the room to the model" : "Blue outlines show shared surfaces"
      : fallback);
    if (this.badge && this.context) {
      const key = title + subtitle;
      if (this.drawn !== key) {
        const ctx = this.context;
        ctx.fillStyle = "#10202e"; ctx.fillRect(0, 0, 640, 106);
        ctx.fillStyle = this.edges.visible ? "#75ceff" : "#ffc077"; ctx.fillRect(0, 0, 8, 106);
        ctx.fillStyle = "#f4f9fc"; ctx.font = '600 34px system-ui'; ctx.fillText(title, 28, 46, 590);
        ctx.fillStyle = "#d0dceb"; ctx.font = '26px system-ui'; ctx.fillText(subtitle, 28, 85, 590);
        this.badge.material.map!.needsUpdate = true;
        this.drawn = key;
      }
      const { position, orientation } = pose.transform;
      if (orientation) {
        this.view.copy(orientation);
        this.destination.set(0, .34, -1.02).applyQuaternion(this.view);
        this.destination.x += position.x; this.destination.y += position.y; this.destination.z += position.z;
        const follow = this.group.visible ? 1 - Math.exp(-12 * Math.min(Math.max(dt, 0), .1)) : 1;
        this.badge.position.lerp(this.destination, follow); this.badge.quaternion.slerp(this.view, follow);
      }
      this.badge.visible = !!orientation;
    }
    this.group.visible = true;
  }

  clear() {
    this.observedAt = -Infinity;
    this.edges.count = 0;
    this.edges.visible = this.group.visible = false;
  }

  dispose() {
    this.clear();
    this.edges.dispose();
    this.edges.geometry.dispose(); this.edges.material.dispose();
    if (this.badge) {
      this.badge.geometry.dispose(); this.badge.material.map?.dispose(); this.badge.material.dispose();
    }
    this.group.removeFromParent(); this.group.clear();
  }
}
