import * as THREE from "three";

const CHAINS: readonly (readonly XRHandJoint[])[] = [
  ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  [
    "wrist",
    "index-finger-metacarpal",
    "index-finger-phalanx-proximal",
    "index-finger-phalanx-intermediate",
    "index-finger-phalanx-distal",
    "index-finger-tip",
  ],
  [
    "wrist",
    "middle-finger-metacarpal",
    "middle-finger-phalanx-proximal",
    "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-distal",
    "middle-finger-tip",
  ],
  [
    "wrist",
    "ring-finger-metacarpal",
    "ring-finger-phalanx-proximal",
    "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-distal",
    "ring-finger-tip",
  ],
  [
    "wrist",
    "pinky-finger-metacarpal",
    "pinky-finger-phalanx-proximal",
    "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-distal",
    "pinky-finger-tip",
  ],
  [
    "index-finger-phalanx-proximal",
    "middle-finger-phalanx-proximal",
    "ring-finger-phalanx-proximal",
    "pinky-finger-phalanx-proximal",
  ],
];

const JOINTS = [...new Set(CHAINS.flat())];
const WRIST = JOINTS.indexOf("wrist");
const BONES = CHAINS.flatMap((chain) =>
  chain.slice(1).map((joint, i) => ({
    a: JOINTS.indexOf(chain[i]!),
    b: JOINTS.indexOf(joint),
    palm: chain[i] === "wrist",
  })),
);
const UP = new THREE.Vector3(0, 1, 0);

function trackedPosition(pose: XRPose | undefined): DOMPointReadOnly | undefined {
  const p = pose?.transform.position;
  return pose &&
    !pose.emulatedPosition &&
    p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z)
    ? p
    : undefined;
}

/** Schematic, locally rendered input cues. Attach to the VR rig in local-floor coordinates. */
export class HandHints {
  readonly group = new THREE.Group();
  private readonly boneGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
  private readonly gripGeometry = new THREE.CapsuleGeometry(0.019, 0.052, 3, 8).rotateX(Math.PI / 2);
  private readonly gripDetail = new THREE.CapsuleGeometry(0.008, 0.024, 2, 6)
    .rotateX(Math.PI / 2)
    .translate(0, 0.015, -0.027);
  private readonly accent = new THREE.MeshBasicMaterial({ color: 0xecf8f8 });
  private readonly slots = (["left", "right"] as const).map((side) => {
    const material = new THREE.MeshBasicMaterial({ color: side === "left" ? 0x72d1db : 0x9ad7fa });
    const bones = new THREE.InstancedMesh(this.boneGeometry, material, BONES.length);
    bones.name = `vh-${side}-hand-skeleton`;
    bones.frustumCulled = false;
    bones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const grip = new THREE.Group();
    grip.name = `vh-${side}-controller-grip`;
    grip.matrixAutoUpdate = false;
    grip.add(new THREE.Mesh(this.gripGeometry, material), new THREE.Mesh(this.gripDetail, this.accent));
    this.group.add(bones, grip);
    return {
      side,
      bones,
      grip,
      material,
      positions: JOINTS.map(() => new THREE.Vector3()),
      tracked: new Uint8Array(JOINTS.length),
    };
  });
  private readonly matrix = new THREE.Matrix4();
  private readonly direction = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private disposed = false;

  constructor() {
    this.group.name = "vh-vr-input-hints";
    this.hide();
  }

  update(frame: XRFrame, reference: XRReferenceSpace, sources: readonly XRInputSource[]): void {
    this.hide();
    if (this.disposed || frame.session.visibilityState !== "visible") return;
    let firstUnhanded: XRInputSource | undefined;
    for (const slot of this.slots) {
      const source =
        sources.find((input) => input.handedness === slot.side && (input.hand || input.gripSpace)) ??
        sources.find(
          (input) =>
            input.handedness === "none" && input !== firstUnhanded && (input.hand || input.gripSpace),
        );
      if (source?.handedness === "none" && !firstUnhanded) firstUnhanded = source;
      if (source?.hand) this.updateHand(frame, reference, source.hand, slot);
      else if (source?.gripSpace) {
        const pose = frame.getPose(source.gripSpace, reference);
        if (!pose || !trackedPosition(pose) || !pose.transform.matrix.every(Number.isFinite)) continue;
        slot.grip.matrix.fromArray(pose.transform.matrix);
        slot.grip.matrixWorldNeedsUpdate = true;
        slot.grip.visible = true;
      }
    }
  }

  private updateHand(
    frame: XRFrame,
    reference: XRReferenceSpace,
    hand: XRHand,
    slot: (typeof this.slots)[number],
  ): void {
    if (!frame.getJointPose) return;
    slot.tracked.fill(0);
    for (const [i, jointName] of JOINTS.entries()) {
      const joint = hand.get(jointName);
      const p = joint && trackedPosition(frame.getJointPose(joint, reference));
      if (!p) continue;
      slot.positions[i]!.set(p.x, p.y, p.z);
      slot.tracked[i] = 1;
    }
    if (!slot.tracked[WRIST]) return;
    let count = 0;
    for (const { a, b, palm } of BONES) {
      if (!slot.tracked[a] || !slot.tracked[b]) continue;
      const from = slot.positions[a]!;
      const to = slot.positions[b]!;
      this.direction.subVectors(to, from);
      const length = this.direction.length();
      if (length < 0.002) continue;
      this.rotation.setFromUnitVectors(UP, this.direction.multiplyScalar(1 / length));
      this.centre.copy(from).lerp(to, 0.5);
      const radius = palm ? 0.005 : 0.0035;
      this.scale.set(radius, length + radius, radius);
      slot.bones.setMatrixAt(count++, this.matrix.compose(this.centre, this.rotation, this.scale));
    }
    slot.bones.count = count;
    slot.bones.instanceMatrix.needsUpdate = count > 0;
    slot.bones.visible = count > 0;
  }

  hide(): void {
    for (const slot of this.slots) {
      slot.bones.count = 0;
      slot.bones.visible = false;
      slot.grip.visible = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    for (const { bones, material } of this.slots) {
      bones.dispose();
      material.dispose();
    }
    this.boneGeometry.dispose();
    this.gripGeometry.dispose();
    this.gripDetail.dispose();
    this.accent.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
