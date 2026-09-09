import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { EquipmentOcclusionCache } from "@/house/scene/equipmentOcclusionCache";
import { buildScene } from "./sceneFromGlb";
import { FIXTURE_DIR } from "./glb";

afterEach(() => vi.useRealTimers());
it("shares mount queries, caps camera updates, and schedules only one trailing frame", () => {
  vi.useFakeTimers();
  const { index, clip } = buildScene(FIXTURE_DIR);
  const cache = new EquipmentOcclusionCache();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(2,8,2); camera.lookAt(2,0,2); camera.updateMatrixWorld();
  const invalidate = vi.fn();
  const point = new THREE.Vector3(1,1,1);
  cache.beginFrame(index,clip,camera,0,invalidate,0);
  cache.isOccluded(point);cache.isOccluded(point.clone());
  expect(cache.queries).toBe(1);
  cache.beginFrame(index,clip,camera,0,invalidate,1);
  expect(cache.batches).toBe(1);
  for (let now=2;now<100;now++) {
    camera.position.x+=0.01;camera.updateMatrixWorld();
    cache.beginFrame(index,clip,camera,0,invalidate,now);
    cache.isOccluded(point);
  }
  expect(cache.queries).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(100);
  expect(invalidate).toHaveBeenCalledTimes(1);
  cache.beginFrame(index,clip,camera,0,invalidate,100);
  cache.isOccluded(point);
  expect(cache.batches).toBe(2);
  expect(cache.queries).toBe(2);
  cache.beginFrame(index,clip,camera,1,invalidate,101);
  expect(cache.batches).toBe(3); // visibility/cuts bypass the camera throttle
  vi.advanceTimersByTime(1000);
  expect(invalidate).toHaveBeenCalledTimes(1);
  cache.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
