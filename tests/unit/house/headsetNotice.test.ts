import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadsetNotice } from "@/house/xr/headsetNotice";

function fixture() {
  const paint = {
    beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), arc: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fillText: vi.fn(),
    clearRect: vi.fn(), createLinearGradient: () => ({ addColorStop: vi.fn() }),
    measureText: (text: string) => ({ width: text.length * 16 }),
  };
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => paint }) });
  const notice = new HeadsetNotice();
  return { notice, paint, texture: notice.mesh.material.map! };
}

const head = new THREE.Vector3(0, 1.7, 0);
const ahead = new THREE.Quaternion();

afterEach(() => vi.unstubAllGlobals());

describe("headset notice", () => {
  it("anchors to a fixed tracking-space pose, settles and fully hides without idle texture updates", () => {
    const { notice, paint, texture } = fixture();
    expect(notice.mesh.visible).toBe(false);
    notice.show({ title: "Arrived", detail: "North atrium", tone: "arrival" }, head, ahead, 100);
    const position = notice.mesh.position.clone();
    const version = texture.version;
    expect(position.y).toBeGreaterThan(head.y);
    expect(position.z).toBeLessThan(head.z);
    expect(notice.mesh.material.opacity).toBe(1);
    notice.show({ title: "Arrived", detail: "North atrium", tone: "arrival" }, new THREE.Vector3(3, 2, 5), ahead, 900);
    expect(notice.mesh.position.equals(position)).toBe(true);
    expect(texture.version).toBe(version);
    expect(paint.clearRect).toHaveBeenCalledTimes(1);
    notice.tick(1_900);
    expect(notice.mesh.material.opacity).toBe(1);
    notice.tick(3_040);
    expect(notice.mesh.material.opacity).toBeGreaterThan(0);
    expect(notice.mesh.material.opacity).toBeLessThan(1);
    notice.tick(3_300);
    expect(notice.mesh.visible).toBe(false);
    notice.tick(4_500);
    expect(texture.version).toBe(version);
    notice.dispose();
  });

  it("keeps an interruption visible until cleared and reuses its texture after a tracking reset", () => {
    const { notice, texture } = fixture();
    const warning = { title: "Tracking paused", detail: "Look around to recover alignment.", tone: "warning", durationMs: null } as const;
    notice.show(warning, head, ahead, 100);
    const version = texture.version;
    notice.tick(60_000);
    expect(notice.mesh.visible).toBe(true);
    expect(notice.mesh.material.opacity).toBe(1);
    notice.hide();
    expect(notice.mesh.visible).toBe(false);
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    notice.show(warning, head, turn, 75_000);
    expect(notice.mesh.position.x).toBeLessThan(-.95);
    expect(texture.version).toBe(version);
    notice.show({ title: "Left the station", tone: "info" }, head, ahead, 76_000);
    expect(texture.version).toBe(version + 1);
    notice.show({ title: " " }, head, ahead, 77_000);
    expect(notice.mesh.visible).toBe(false);
    notice.dispose();
  });

  it("detaches and disposes all three GPU resources", () => {
    const { notice, texture } = fixture();
    const group = new THREE.Group();
    group.add(notice.mesh);
    const geometry = vi.spyOn(notice.mesh.geometry, "dispose");
    const material = vi.spyOn(notice.mesh.material, "dispose");
    const map = vi.spyOn(texture, "dispose");
    notice.dispose();
    expect(group.children).toHaveLength(0);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(map).toHaveBeenCalledTimes(1);
  });
});
