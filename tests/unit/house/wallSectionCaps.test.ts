import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { expect, it } from "vitest";
import { wallSectionGeometry } from "@/house/scene/wallSectionCaps";

it("caps a diagonal wall around the opening but leaves the full walk-through clear", () => {
  const wall = new THREE.Group();
  wall.position.set(0, 3, 0);
  wall.rotation.y = Math.PI / 4;
  const topGeometry = new THREE.PlaneGeometry(5, .2).rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(topGeometry);
  top.position.y = 2.4;
  wall.add(top);
  // Approximate door aperture as in the GLB: two jamb faces through the thickness.
  const jamb = new THREE.PlaneGeometry(.2, 1.9).rotateY(Math.PI / 2);
  const left = jamb.clone().translate(-.5, 1.15, 0);
  const right = jamb.clone().translate(.5, 1.15, 0);
  const reveal = new THREE.Mesh(mergeGeometries([left, right])!);
  wall.add(reveal);
  left.dispose();
  right.dispose();
  wall.updateWorldMatrix(true, true);
  const section = new THREE.Mesh(wallSectionGeometry(top, [reveal], 3.9));
  wall.add(section);
  wall.updateWorldMatrix(true, true);

  const hitsAt = (x: number, z = 0) => {
    const origin = wall.localToWorld(new THREE.Vector3(x, 3, z));
    return new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0)).intersectObject(section);
  };
  expect(hitsAt(-.54)[0]?.point.y).toBeCloseTo(3.9);
  expect(hitsAt(.54)[0]?.point.y).toBeCloseTo(3.9);
  expect(hitsAt(-.46)).toHaveLength(0);
  expect(hitsAt(.46)).toHaveLength(0);
  expect(hitsAt(0)).toHaveLength(0);
  expect(hitsAt(.54, .12)).toHaveLength(0);

  for (const height of [3.1, 5.2]) {
    section.geometry.dispose();
    section.geometry = wallSectionGeometry(top, [reveal], height);
    expect(hitsAt(0)[0]?.point.y).toBeCloseTo(height);
  }
  section.geometry.dispose();
  topGeometry.dispose();
  jamb.dispose();
  reveal.geometry.dispose();
});

it("uses real paired side faces when the legacy top is flagged invalid", () => {
  const corrupt = new THREE.Mesh(new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2));
  corrupt.userData.vhInvalidWallCap = true;
  corrupt.position.y = 4;
  const sides = [-.1, .1].flatMap(z => [-1.25, 1.25].map(x => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2));
    mesh.position.set(x, 1, z);
    return mesh;
  }));
  const cap = new THREE.Mesh(wallSectionGeometry(corrupt, [], .9, sides));
  cap.updateMatrixWorld();
  const ray = new THREE.Vector3(0, -1, 0);
  const pick = (x: number, z = 0) => new THREE.Raycaster(new THREE.Vector3(x, 2, z), ray).intersectObject(cap);
  expect(pick(-.53)[0]?.point.y).toBeCloseTo(.9);
  expect(pick(.53)[0]?.point.y).toBeCloseTo(.9);
  expect(pick(0)).toHaveLength(0);
  expect(pick(.53, .2)).toHaveLength(0);
  cap.geometry.dispose();
  corrupt.geometry.dispose();
  for (const side of sides) side.geometry.dispose();
});
