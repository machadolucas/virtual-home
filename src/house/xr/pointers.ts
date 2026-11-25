import * as THREE from "three";
import type { Vec3 } from "../model/types";

function badge(text: string, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 90;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mesh.renderOrder = 1004;
  let last: string | undefined;
  function write(label: string) {
    if (label === last) return;
    last = label;
    ctx.fillStyle = "#193338";
    ctx.fillRect(0, 0, 512, 90);
    ctx.fillStyle = "#72e0c7";
    ctx.fillRect(0, 0, 8, 90);
    ctx.font = "bold 43px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, 20, 61, 474);
    texture.needsUpdate = true;
  }
  write(text);
  return {
    mesh,
    write,
    dispose() {
      texture.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
/** Overlay only the intersected body/instance or route span. Geometry owned by the house stays shared. */
export class TargetHighlight {
  readonly group = new THREE.Group();
  private readonly empty = new THREE.BufferGeometry();
  private readonly tint = new THREE.MeshBasicMaterial({
    color: 0x74f3d6,
    transparent: true,
    opacity: 0.27,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  private readonly body = new THREE.Mesh(this.empty, this.tint);
  private readonly path = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(),
  ]);
  private readonly solid = new THREE.LineBasicMaterial({
    color: 0xc1fff1,
    depthTest: false,
    depthWrite: false,
  });
  private readonly dotted = new THREE.LineDashedMaterial({
    color: 0xc1fff1,
    dashSize: 0.06,
    gapSize: 0.045,
    depthTest: false,
    depthWrite: false,
  });
  private readonly line = new THREE.Line(this.path, this.solid);
  private readonly transform = new THREE.Matrix4();
  private readonly distances = new THREE.Float32BufferAttribute([0, 1], 1);

  constructor() {
    this.path.setAttribute("lineDistance", this.distances);
    this.body.matrixAutoUpdate = this.line.matrixAutoUpdate = false;
    this.line.frustumCulled = false;
    this.body.renderOrder = 995;
    this.line.renderOrder = 996;
    this.group.add(this.body, this.line);
    this.clear();
  }
  clear() {
    this.body.visible = this.line.visible = false;
  }
  private toLocal(object: THREE.Object3D) {
    this.group.updateWorldMatrix(true, false);
    return this.transform.copy(this.group.matrixWorld).invert().multiply(object.matrixWorld);
  }
  equipment(mesh: THREE.Mesh, instanceId?: number) {
    this.body.geometry = mesh.geometry;
    if (instanceId !== undefined && mesh instanceof THREE.InstancedMesh) {
      mesh.getMatrixAt(instanceId, this.body.matrix);
      this.body.matrix.premultiply(this.toLocal(mesh));
    } else this.body.matrix.copy(this.toLocal(mesh));
    this.body.matrixWorldNeedsUpdate = true;
    this.body.visible = true;
  }
  route(root: THREE.Group, segment: readonly [Vec3, Vec3], approximate: boolean) {
    const [a, b] = segment;
    const positions = this.path.attributes.position!;
    positions.setXYZ(0, a[0], a[1], a[2]);
    positions.setXYZ(1, b[0], b[1], b[2]);
    positions.needsUpdate = true;
    this.distances.setX(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    this.distances.needsUpdate = true;
    this.line.material = approximate ? this.dotted : this.solid;
    this.line.matrix.copy(this.toLocal(root));
    this.line.matrixWorldNeedsUpdate = true;
    this.line.visible = true;
  }
  dispose() {
    this.group.removeFromParent();
    this.empty.dispose();
    this.tint.dispose();
    this.path.dispose();
    this.solid.dispose();
    this.dotted.dispose();
  }
}
export class InputBeams {
  readonly group = new THREE.Group();
  private geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, -1),
  ]);
  private ball = new THREE.SphereGeometry(0.007, 10, 6);
  private orange = new THREE.MeshBasicMaterial({
    color: 0xffad48,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  readonly wrist = badge("Menu", 0.106, 0.034);
  readonly slots = [0, 1].map(() => {
    const line = new THREE.Line(
      this.geometry,
      new THREE.LineBasicMaterial({
        color: 0xabc6c9,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const dot = new THREE.Mesh(
      this.ball,
      new THREE.MeshBasicMaterial({
        color: 0x8dffde,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    );
    const probe = new THREE.Mesh(this.ball, this.orange);
    const highlight = new TargetHighlight();
    const label = badge("", 0.21, 0.037);
    line.renderOrder = 1001;
    dot.renderOrder = 1002;
    probe.renderOrder = 1003;
    this.group.add(line, dot, probe, label.mesh, highlight.group);
    return { line, dot, probe, label, highlight };
  });
  constructor() {
    this.group.add(this.wrist.mesh);
    this.wrist.mesh.visible = false;
    this.clear();
  }
  clear() {
    for (const { line, dot, probe, label, highlight } of this.slots) {
      highlight.clear();
      line.visible = dot.visible = probe.visible = label.mesh.visible = false;
    }
  }
  dispose() {
    this.wrist.dispose();
    this.geometry.dispose();
    this.ball.dispose();
    this.orange.dispose();
    for (const { line, dot, label, highlight } of this.slots) {
      highlight.dispose();
      line.material.dispose();
      dot.material.dispose();
      label.dispose();
    }
    this.group.removeFromParent();
  }
}
export function pulse(source: XRInputSource) {
  const pad = source.gamepad as
    | (Gamepad & { hapticActuators?: Array<{ pulse: (amplitude: number, ms: number) => Promise<unknown> }> })
    | undefined;
  if (pad?.hapticActuators?.[0]) void pad.hapticActuators[0].pulse(0.35, 30).catch(() => {});
  else if (pad?.vibrationActuator?.playEffect)
    void pad.vibrationActuator
      .playEffect("dual-rumble", { duration: 30, weakMagnitude: 0.35, strongMagnitude: 0.12 })
      .catch(() => {});
}
