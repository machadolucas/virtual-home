import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ClipGroups } from "@/house/scene/clipGroups";
import { furnishingRaycast } from "@/house/scene/furnishingRaycast";

function fixture() {
  const parent = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  parent.add(mesh);
  parent.updateMatrixWorld(true);
  return { parent, mesh };
}

function hits(mesh: THREE.Mesh, origin: THREE.Vector3): THREE.Intersection[] {
  const result: THREE.Intersection[] = [];
  mesh.raycast(new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -1)), result);
  return result;
}

describe("furnishing raycast", () => {
  it("ignores a hidden mesh and a hidden ancestor", () => {
    const { parent, mesh } = fixture();
    mesh.raycast = furnishingRaycast(() => true);
    expect(hits(mesh, new THREE.Vector3(0, 0, 5))).not.toHaveLength(0);
    mesh.visible = false;
    expect(hits(mesh, new THREE.Vector3(0, 0, 5))).toHaveLength(0);
    mesh.visible = true;
    parent.visible = false;
    expect(hits(mesh, new THREE.Vector3(0, 0, 5))).toHaveLength(0);
  });

  it("keeps hits on rendered fragments and drops hits removed by cutaway planes", () => {
    const { mesh } = fixture();
    const clip = new ClipGroups(["f-upper"]);
    clip.setCut(
      "f-upper",
      { enabled: true, y: 3, vertical: { axis: "x", v: 0, sign: 1 } },
      0,
    );
    mesh.raycast = furnishingRaycast((point) => clip.keeps("f-upper", point));

    expect(hits(mesh, new THREE.Vector3(-0.5, 0, 5))).not.toHaveLength(0);
    expect(hits(mesh, new THREE.Vector3(0.5, 0, 5))).toHaveLength(0);
  });
});
