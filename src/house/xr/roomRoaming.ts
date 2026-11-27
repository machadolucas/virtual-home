import { Matrix4, Vector3 } from "three";
import { signedClearance } from "../model/geometry2d";
import type { Room } from "../model/types";

/** Identify the room containing the tracked head without changing the verified registration. */
export class RoomRoaming {
  origin: Room | null = null;
  betweenRooms = false;
  private eyeHeight = 0;
  private pending: Room | null = null;
  private since = 0;
  private last = -Infinity;
  private readonly inverse = new Matrix4();
  private readonly head = new Vector3();

  reset() {
    this.origin = this.pending = null;
    this.betweenRooms = false;
    this.last = -Infinity;
  }

  observe(rooms: Room[], current: Room, matrix: Matrix4, position: DOMPointReadOnly, now: number): Room | null {
    if (now - this.last < 100) return null;
    const fresh = now - this.last < 500;
    this.last = now;
    const head = this.head.set(position.x, position.y, position.z).applyMatrix4(this.inverse.copy(matrix).invert());
    if (!this.origin) {
      this.origin = current;
      this.eyeHeight = head.y - current.floorElevation;
    }
    const height = head.y - current.floorElevation;
    if (height > .25 && height <= (current.ceilingHeight ?? 2.7) + .12 &&
        signedClearance(head.x, head.z, current.footprint) >= -.10) {
      this.pending = current; this.since = now; this.betweenRooms = false;
      return null;
    }
    let target: Room | null = null;
    for (const room of rooms) {
      if (room === current || room.kind === "attic" || room.kind === "void") continue;
      const eye = head.y - room.floorElevation;
      if (eye < .35 || eye > (room.ceilingHeight ?? 2.7) + .12) continue;
      if (room.floorId !== current.floorId && Math.abs(eye - this.eyeHeight) > .55) continue;
      if (signedClearance(head.x, head.z, room.footprint) < .17) continue;
      if (target) { target = null; break; } // Overlap: wait for a unique interior.
      target = room;
    }
    if (!fresh || target !== this.pending) {
      this.pending = target; this.since = now;
      return null;
    }
    if (now - this.since < (target ? 350 : 800)) return null;
    this.betweenRooms = !target;
    return target;
  }
}
