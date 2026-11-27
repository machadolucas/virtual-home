import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineDashedMaterial, LineSegments, Matrix4, Vector3 } from "three";
import { signedClearance } from "../model/geometry2d";
import type { Room } from "../model/types";
import type { RoomEvidence } from "./roomAlignment";

/** Native measurements stay in their original tracking space. Only the model follows the anchor. */
export class RoomWallComparison {
  readonly group = new Group();
  private readonly recorded = new LineSegments(new BufferGeometry(), new LineBasicMaterial({
    color:0x72d7ff, toneMapped:false, depthWrite:false,
  }));
  private readonly modeled = new LineSegments(new BufferGeometry(), new LineDashedMaterial({
    color:0xffb75e, dashSize:0.14, gapSize:0.07, toneMapped:false, depthWrite:false,
  }));
  enabled = false;

  constructor(room: Room, evidence: RoomEvidence, registration: Matrix4) {
    this.group.visible = false;
    this.modeled.matrixAutoUpdate = false;
    const measured: number[] = [], modeled: number[] = [];
    const inverse = registration.clone().invert();
    const floor = evidence.floor;
    if (floor) {
      const midpoint = new Vector3();
      for (const w of evidence.walls) {
        if (!w.semanticWall || w.baseOnly || Math.abs(w.low - floor.y) > .12) continue;
        midpoint.set((w.a[0]+w.b[0])/2, floor.y, (w.a[1]+w.b[1])/2).applyMatrix4(inverse);
        if (signedClearance(midpoint.x,midpoint.z,room.footprint) < -1) continue;
        measured.push(w.a[0],w.low+.12,w.a[1], w.b[0],w.low+.12,w.b[1]);
      }
    }
    for (const ring of [room.footprint.outer, ...(room.footprint.holes ?? [])]) {
      ring.forEach(([x,z],i) => {
        const b = ring[(i+1)%ring.length]!;
        modeled.push(x,room.floorElevation+.15,z, b[0],room.floorElevation+.15,b[1]);
      });
    }
    this.recorded.geometry.setAttribute("position", new Float32BufferAttribute(measured,3));
    this.modeled.geometry.setAttribute("position", new Float32BufferAttribute(modeled,3));
    this.modeled.computeLineDistances();
    this.group.add(this.recorded,this.modeled);
  }

  frame(pose: Matrix4 | null) {
    this.group.visible = this.enabled && !!pose;
    if (this.group.visible && pose) {
      this.modeled.matrix.copy(pose);
      this.modeled.matrixWorldNeedsUpdate = true;
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const lines of [this.recorded,this.modeled]) {
      lines.geometry.dispose();
      lines.material.dispose();
    }
  }
}
