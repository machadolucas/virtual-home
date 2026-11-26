import { Box3, Ray, Triangle, Vector3 } from "three";

// An oblique ray avoids axis-aligned edges of walls and cabinets. Coincident face hits count once.
const direction = new Vector3(1, 0.2137, 0.4231).normalize();

/** Triangle-box collision alone misses a body *entirely inside* a closed solid.
 * Confirm the shell is closed before classifying its interior, including GLB vertex seams. */
export class SolidInterior {
  private closed?: boolean;
  private ray = new Ray(new Vector3(), direction);
  private hit = new Vector3();
  private distances: number[] = [];

  constructor(private bounds: Box3, private triangles: Triangle[]) {}

  containsBody(body: Box3) {
    if (!this.bounds.containsBox(body)) return false;
    this.closed ??= this.isClosed();
    if (!this.closed) return false;
    body.getCenter(this.ray.origin);
    this.distances.length = 0;
    for (const {a, b, c} of this.triangles) {
      if (!this.ray.intersectTriangle(a, b, c, false, this.hit)) continue;
      const d = this.ray.origin.distanceTo(this.hit);
      if (!this.distances.some(previous => Math.abs(previous - d) < 1e-6)) this.distances.push(d);
    }
    return this.distances.length % 2 === 1;
  }

  private isClosed() {
    const vertices = new Map<string, number>();
    const edges = new Map<string, number>();
    const vertex = (p: Vector3) => {
      const key = [p.x, p.y, p.z].map(x => Math.round(x * 1e6)).join(",");
      if (!vertices.has(key)) vertices.set(key, vertices.size);
      return vertices.get(key)!;
    };
    for (const t of this.triangles) {
      const a = vertex(t.a), b = vertex(t.b), c = vertex(t.c);
      if (a === b || b === c || c === a) continue;
      for (const [i,j] of [[a,b],[b,c],[c,a]] as const) {
        const key = i < j ? i + ":" + j : j + ":" + i;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    return edges.size >= 6 && [...edges.values()].every(n => n === 2);
  }
}
