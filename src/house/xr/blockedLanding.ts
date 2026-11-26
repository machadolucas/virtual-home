import * as THREE from "three";

/** A ring and slash readable against both bright terrain and dark interior surfaces. */
export class BlockedLanding extends THREE.Group {
  private readonly disk: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly symbol: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;

  constructor(radius: number) {
    super();
    this.name = "vh-blocked-landing";
    const ring = new THREE.Shape();
    ring.absarc(0, 0, 1, 0, 2 * Math.PI, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, 0.78, 0, 2 * Math.PI, true);
    ring.holes.push(hole);
    const slash = new THREE.Shape([
      new THREE.Vector2(-0.66, 0.53),
      new THREE.Vector2(-0.53, 0.66),
      new THREE.Vector2(0.66, -0.53),
      new THREE.Vector2(0.53, -0.66),
    ]);
    const ink = (color: number) =>
      new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    this.disk = new THREE.Mesh(new THREE.CircleGeometry(1.07, 28), ink(0x392721));
    this.symbol = new THREE.Mesh(new THREE.ShapeGeometry([ring, slash]), ink(0xffb58a));
    this.disk.renderOrder = 1002;
    this.symbol.renderOrder = 1003;
    this.add(this.disk, this.symbol);
    this.scale.setScalar(radius);
    this.visible = false;
  }
  dispose() {
    this.removeFromParent();
    this.disk.geometry.dispose();
    this.disk.material.dispose();
    this.symbol.geometry.dispose();
    this.symbol.material.dispose();
  }
}
