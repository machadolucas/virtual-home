import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { directLightMaterial, lightBatches, lightReachesBox } from "@/house/scene/batchedLighting";

describe("batched detailed lighting", () => {
  it("conservatively includes every finite-range light whose radius intersects a surface box", () => {
    const light = new THREE.PointLight(0xffffff, 1, 6);
    light.position.set(0, 1, 0);
    light.updateMatrixWorld();

    const largeWall = new THREE.Box3(new THREE.Vector3(5, 0, -8), new THREE.Vector3(15, 3, 8));
    const distantWall = new THREE.Box3(new THREE.Vector3(7, 0, -8), new THREE.Vector3(15, 3, 8));

    expect(lightReachesBox(light, largeWall)).toBe(true);
    expect(lightReachesBox(light, distantWall)).toBe(false);
  });

  it("treats a zero-distance light as unlimited", () => {
    const light = new THREE.SpotLight(0xffffff, 1, 0);
    light.position.set(1_000, 1_000, 1_000);
    light.updateMatrixWorld();

    expect(lightReachesBox(light, new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)))).toBe(true);
  });

  it("groups lights stably by room and position, independent of camera and intensity", () => {
    const makeLight = (name: string, room: string, x: number, z: number, intensity: number) => {
      const light = new THREE.PointLight(0xffffff, intensity);
      light.name = name;
      light.userData.vhRoom = room;
      light.position.set(x, 0, z);
      return light;
    };
    const lights = [
      makeLight("utility", "room-b", 0, 0, 0),
      makeLight("window", "room-a", 2, 0, 100),
      makeLight("door", "room-a", -2, 0, 0.1),
      makeLight("centre", "room-a", 2, -1, 5),
    ];
    const names = () => lightBatches(lights, 2).map((batch) => batch.map((light) => light.name));

    expect(names()).toEqual([["door", "centre"], ["window", "utility"]]);

    lights[0]!.intensity = 100;
    lights[1]!.intensity = 0;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(500, -300, 900);
    camera.updateMatrixWorld();

    expect(names()).toEqual([["door", "centre"], ["window", "utility"]]);
  });

  it("removes only indirect and emissive light while retaining direct PBR shader work", () => {
    const clippingPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -2);
    const source = new THREE.MeshStandardMaterial({
      color: 0x336699,
      emissive: 0x112233,
      emissiveIntensity: 2,
      roughness: 0.37,
      metalness: 0.61,
      clippingPlanes: [clippingPlane],
    });
    source.clipIntersection = true;
    const originalCompile = source.onBeforeCompile;
    const direct = directLightMaterial(source);
    const shader = {
      fragmentShader: [
        "#include <lights_fragment_begin>",
        "#include <lights_fragment_maps>",
        "#include <lights_fragment_end>",
        "#include <aomap_fragment>",
        "#include <fog_fragment>",
      ].join("\n"),
    } as THREE.WebGLProgramParametersWithUniforms;

    direct.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    expect(shader.fragmentShader).toContain("#include <lights_fragment_begin>");
    expect(shader.fragmentShader).toContain("#include <lights_fragment_maps>");
    expect(shader.fragmentShader).toContain("#include <lights_fragment_end>");
    expect(shader.fragmentShader).toContain("reflectedLight.indirectDiffuse = vec3(0.0)");
    expect(shader.fragmentShader).toContain("reflectedLight.indirectSpecular = vec3(0.0)");
    expect(shader.fragmentShader).toContain("totalEmissiveRadiance = vec3(0.0)");
    expect(source.onBeforeCompile).toBe(originalCompile);
    expect(source.clippingPlanes).toEqual([clippingPlane]);
    expect(source.clipIntersection).toBe(true);
    expect(source).toMatchObject({ roughness: 0.37, metalness: 0.61, emissiveIntensity: 2 });
    expect(direct.clippingPlanes).toEqual([clippingPlane]);
    expect(direct.clipIntersection).toBe(true);

    direct.dispose();
    source.dispose();
  });
});
