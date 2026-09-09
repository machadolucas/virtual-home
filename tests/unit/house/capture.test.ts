import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { captureHouseView, gradientEndpoints } from "@/house/capture";

afterEach(() => vi.unstubAllGlobals());

describe("image capture", () => {
  it("matches the CSS gradient endpoints for vertical and horizontal gradients", () => {
    gradientEndpoints(800, 400, 180).forEach((value, i) => expect(value).toBeCloseTo([400, 0, 400, 400][i]!));
    gradientEndpoints(800, 400, 90).forEach((value, i) => expect(value).toBeCloseTo([0, 200, 800, 200][i]!));
    expect(gradientEndpoints(800, 400, 45)[3]).toBeLessThan(0);
  });

  it.each([false, true])("restores guides and renderer state when capture throws: %s", async (fail) => {
    const operations: string[] = [];
    const scene = new THREE.Scene();
    const guide = new THREE.Group();
    guide.name = "vh-snap-indicator";
    scene.add(guide);
    const context = { fillRect: () => operations.push("background"), drawImage: () => operations.push("scene"), fillStyle: "" };
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0,
      getContext: () => context, toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["PNG"], { type: "image/png" })) }) });
    vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "#123456" }));
    const target = {};
    let renderTarget: unknown = target;
    const renderer = { domElement: { width: 800, height: 400 },
      getContext: () => ({ isContextLost: () => false }), getRenderTarget: () => renderTarget,
      setRenderTarget: (next: unknown) => { renderTarget = next; },
      render: () => { expect(guide.visible).toBe(false); if (fail) throw new Error("GPU failure"); },
    } as unknown as THREE.WebGLRenderer;
    const result = captureHouseView({ renderer, scene, camera: new THREE.PerspectiveCamera(),
      host: {} as HTMLElement, labelHost: null, background: { mode: "theme" } });
    if (fail) await expect(result).rejects.toThrow("GPU failure");
    else {
      expect((await result).type).toBe("image/png");
      expect(operations).toEqual(["background", "scene"]);
    }
    expect(guide.visible).toBe(true);
    expect(renderTarget).toBe(target);
  });
});
