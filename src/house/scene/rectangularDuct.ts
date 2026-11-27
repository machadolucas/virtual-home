import { BoxGeometry, BufferAttribute, Vector3 } from "three";
import type { Vec3 } from "@/house/model/types";

const up = new Vector3(0, 1, 0);
const xAxis = new Vector3(1, 0, 0);

/** Each side of a bend uses the same four mitered corners. Width runs horizontally
 * on level ducts; for a vertical riser the adjoining horizontal run supplies the roll. */
export function rectangularDuctSpan(a: Vec3, b: Vec3, width: number, height: number, previous?: Vec3, next?: Vec3) {
  const start = new Vector3(...a), end = new Vector3(...b);
  const axis = end.clone().sub(start).normalize();
  const before = previous ? start.clone().sub(new Vector3(...previous)).normalize() : axis;
  const after = next ? new Vector3(...next).sub(end).normalize() : axis;
  const lateral = (direction: Vector3) => new Vector3().crossVectors(direction, up);
  const ring = (left: Vector3, right: Vector3) => {
    const tangent = left.clone().add(right);
    if (tangent.lengthSq() < .0001) tangent.copy(axis);
    tangent.normalize();
    const wide = lateral(tangent);
    if (wide.lengthSq() < .0001) {
      wide.copy(lateral(before));
      if (wide.lengthSq() < .0001) wide.copy(lateral(after));
      if (wide.lengthSq() < .0001) wide.copy(xAxis);
    }
    wide.normalize();
    const deep = new Vector3().crossVectors(wide, tangent).normalize();
    const bend = right.clone().sub(left).normalize();
    const miter = Math.min(2, 1 / Math.max(.01, tangent.dot(right))) - 1;
    wide.addScaledVector(bend, miter * wide.dot(bend));
    deep.addScaledVector(bend, miter * deep.dot(bend));
    return { wide: wide.multiplyScalar(width), deep: deep.multiplyScalar(height) };
  };
  const first = ring(before, axis), last = ring(axis, after);
  const geometry = new BoxGeometry(1, 1, 1);
  const positions = geometry.getAttribute("position");
  const ends = new Float32Array(positions.count);
  const p = new Vector3();
  for (let i = 0; i < positions.count; i++) {
    const far = positions.getY(i) > 0, section = far ? last : first;
    ends[i] = far ? 1 : 0;
    p.copy(far ? end : start).addScaledVector(section.wide, positions.getX(i)).addScaledVector(section.deep, positions.getZ(i));
    positions.setXYZ(i, p.x, p.y, p.z);
  }
  geometry.computeVertexNormals();
  geometry.setAttribute("vhDuctEnd", new BufferAttribute(ends, 1));
  return geometry;
}
