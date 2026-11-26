import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room, Route, Vec2 } from "../model/types";
import { isActivePipeOrDuct } from "../model/routeVisibility";
import type { WalkWorld } from "./walkWorld";
import type { PanelPage } from "./panel";

type MapHit = { point: THREE.Vector3; local: THREE.Vector3; room?: Room; route?: Route; label: string };
function arrow(color: number) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.014);
  shape.lineTo(0.009, -0.009);
  shape.lineTo(0, -0.005);
  shape.lineTo(-0.009, -0.009);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false }),
  );
}
const path = (ring: readonly Vec2[]) => ring.map(([x, z]) => new THREE.Vector2(x, -z));

export class Tabletop {
  readonly group = new THREE.Group();
  private readonly model = new THREE.Group();
  private readonly user = arrow(0xffe39e);
  private readonly arrival = arrow(0x72ffda);
  private readonly base = new THREE.Group();
  private readonly roomMeshes = new Map<THREE.Mesh, Room>();
  private readonly ducts = new Map<THREE.Line, Route>();
  private floor: string;
  private trace = false;
  private chosen: Route | null = null;
  private held: { dest: THREE.Vector3; start: THREE.Vector3; heading: number; label: string } | null = null;
  private hoverText = "";
  private size: number;
  private readonly inverse = new THREE.Matrix4();
  private readonly pick = new THREE.Raycaster();

  constructor(
    private runtime: HouseRuntime,
    private world: WalkWorld,
    head: THREE.Vector3,
    heading: number,
    floor: string | undefined,
    private travel: (p: THREE.Vector3, yaw: number) => void,
    private back: () => void,
  ) {
    const index = runtime.manifest!;
    this.floor = floor ?? index.floorOrder[0]!;
    const bounds = new THREE.Box3();
    // Copy the terrain geometry into the miniature once, keeping the mounted scene's resources untouched.
    for (const mesh of runtime.index?.pickables ?? []) {
      if (!(mesh instanceof THREE.Mesh)) continue;
      const id = runtime.index!.meshSurfaceId.get(mesh);
      const role = id && index.surfaces.get(id)?.role;
      if (role !== "paving" && role !== "ground") continue;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      if (geo.boundingBox) bounds.union(geo.boundingBox);
      this.base.add(
        new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color: role === "ground" ? 0x355b51 : 0x67877b,
            side: THREE.DoubleSide,
          }),
        ),
      );
    }
    let ordinal = 0;
    for (const room of index.rooms.values()) {
      if (room.footprint.outer.length < 3) continue;
      const shape = new THREE.Shape(path(room.footprint.outer));
      for (const ring of room.footprint.holes ?? []) shape.holes.push(new THREE.Path(path(ring)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.24, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, room.floorElevation + 0.08, 0);
      geo.computeBoundingBox();
      if (geo.boundingBox) bounds.union(geo.boundingBox);
      const color = [0x569d96, 0x69b2a2, 0x72a7b5, 0x83ac96][ordinal++ % 4]!;
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
      mesh.add(
        new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 25),
          new THREE.LineBasicMaterial({ color: 0xc7f1db }),
        ),
      );
      this.roomMeshes.set(mesh, room);
      this.model.add(mesh);
    }
    for (const route of runtime.store.getState().routes) {
      if (
        route.kind !== "duct" ||
        !isActivePipeOrDuct(route) ||
        route.needsReconciliation ||
        route.points.length < 2
      )
        continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(route.points.map((p) => new THREE.Vector3(...p))),
        new THREE.LineBasicMaterial({ color: 0xffc47f, depthTest: false, transparent: true }),
      );
      line.renderOrder = 4;
      this.model.add(line);
      this.ducts.set(line, route);
    }
    this.model.add(this.base);
    this.group.add(this.model, this.user, this.arrival);
    const center = bounds.getCenter(new THREE.Vector3()),
      span = bounds.getSize(new THREE.Vector3());
    this.size = 0.73 / Math.max(span.x, span.z, 2);
    this.model.scale.setScalar(this.size);
    this.model.position.copy(center).multiplyScalar(-this.size);
    this.model.position.y = -(bounds.isEmpty() ? 0 : bounds.min.y) * this.size;
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.group.position.set(0.03, -0.48, -0.69).applyQuaternion(rotation).add(head);
    // Closest edge is always below the menu. The miniature keeps the model's world heading.
    this.arrival.visible = false;
    this.arrival.renderOrder = this.user.renderOrder = 7;
    this.refresh();
    this.group.updateMatrixWorld(true);
  }
  private refresh() {
    for (const [mesh, room] of this.roomMeshes) {
      // All rooms at the selected elevation remain visible, including detached buildings.
      const level = this.runtime.manifest!.floors.get(this.floor)?.elevation ?? 0;
      mesh.visible = this.trace || Math.abs(room.floorElevation - level) < 0.45;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.transparent = this.trace;
      mat.opacity = this.trace ? 0.22 : 1;
      mat.depthWrite = !this.trace;
    }
    for (const [line, route] of this.ducts) {
      line.visible = this.trace;
      const m = line.material as THREE.LineBasicMaterial;
      m.color.setHex(this.chosen?.id === route.id ? 0x63ffe0 : 0xffba78);
      m.opacity = !this.chosen || this.chosen.id === route.id ? 1 : 0.19;
    }
    this.held = null;
    this.arrival.visible = false;
  }
  userPose(feet: THREE.Vector3, heading: number) {
    this.user.position.copy(feet).multiplyScalar(this.size).add(this.model.position);
    this.user.position.y += 0.012;
    this.user.rotation.y = heading;
  }
  hit(ray: THREE.Ray): MapHit | null {
    this.pick.ray.copy(ray);
    this.pick.params.Line = { threshold: 0.008 };
    if (this.trace) {
      // Three's generic line threshold uses local scale. Ray-test in model metres explicitly.
      this.inverse.copy(this.model.matrixWorld).invert();
      const local = ray.clone().applyMatrix4(this.inverse),
        a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        point = new THREE.Vector3();
      let best = Infinity,
        result: MapHit | null = null;
      for (const [, route] of this.ducts) {
        for (let i = 1; i < route.points.length; i++) {
          a.fromArray(route.points[i - 1]!);
          b.fromArray(route.points[i]!);
          const d = local.distanceSqToSegment(a, b, undefined, point);
          if (d < best && d < (0.007 / this.size) ** 2) {
            best = d;
            result = {
              label: route.name,
              local: point.clone(),
              point: this.model.localToWorld(point.clone()),
              route,
            };
          }
        }
      }
      return result;
    }
    const candidates = [...this.roomMeshes.keys()]
      .filter((m) => m.visible)
      .concat(this.base.children as THREE.Mesh[]);
    const hit = this.pick.intersectObjects(candidates, false)[0];
    if (!hit) return null;
    const room = this.roomMeshes.get(hit.object as THREE.Mesh);
    const local = this.model.worldToLocal(hit.point.clone());
    if (room) local.y = room.floorElevation;
    return {
      point: hit.point,
      local,
      room,
      label: room ? (this.runtime.store.getState().labelPreferences.names[room.id] ?? room.name) : "Yard",
    };
  }
  begin(hit: MapHit, height: number, heading: number) {
    if (this.trace) return;
    const dest = hit.room
      ? this.world.landing(hit.local, height, hit.room)
      : this.world.outdoorLandingAt(hit.local, height);
    if (!dest) {
      this.hoverText = "Choose a clear standing spot";
      return;
    }
    this.held = { dest, start: hit.point.clone(), heading, label: hit.label };
    this.arrival.position.copy(dest).multiplyScalar(this.size).add(this.model.position);
    this.arrival.position.y += 0.018;
    this.arrival.rotation.y = heading;
    this.arrival.visible = true;
  }
  orient(ray: THREE.Ray, axes: { x: number; y: number }, heading: number) {
    if (!this.held) return;
    if (Math.hypot(axes.x, axes.y) > 0.45) this.held.heading = heading + Math.atan2(-axes.x, -axes.y);
    else {
      const start = this.held.start;
      const point = ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -start.y),
        new THREE.Vector3(),
      );
      if (point && Math.hypot(point.x - start.x, point.z - start.z) > 0.026)
        this.held.heading = Math.atan2(start.x - point.x, start.z - point.z);
    }
    this.arrival.rotation.y = this.held.heading;
  }
  release(hit: MapHit | null, id?: string) {
    if (this.trace) {
      if (hit?.route && id === hit.route.id) {
        this.chosen = this.chosen?.id === id ? null : hit.route;
        this.refresh();
      }
      return;
    }
    const held = this.held;
    this.cancel();
    if (held) this.travel(held.dest, held.heading);
  }
  cancel() {
    this.held = null;
    this.arrival.visible = false;
  }
  menu(): PanelPage {
    const index = this.runtime.manifest!;
    const rooms = this.chosen
      ? [
          ...new Set(
            this.chosen.segments.map((s) => s.roomId && index.rooms.get(s.roomId)?.name).filter(Boolean),
          ),
        ]
      : [];
    const levels = [...index.floors.values()].filter(
      (f, i, all) => all.findIndex((x) => Math.abs(x.elevation - f.elevation) < 0.45) === i,
    );
    return {
      title: "Tabletop map",
      lines: [
        this.trace
          ? this.chosen
            ? [this.chosen.name, ...rooms].join(" · ")
            : "Point at a duct and click to follow its entire run."
          : this.held
            ? "Release to arrive · " + this.held.label
            : this.hoverText ||
              "Hold a spot below. Aim a little beyond it or turn the stick to face that way, then release.",
      ],
      back: this.back,
      rows: [
        {
          id: "mode",
          label: this.trace ? "Return to travel" : "Trace ventilation ducts",
          active: this.trace,
          act: () => {
            this.trace = !this.trace;
            this.refresh();
          },
        },
        ...(!this.trace
          ? levels.map((f) => ({
              id: f.id,
              label: f.name,
              active: Math.abs(f.elevation - (index.floors.get(this.floor)?.elevation ?? 0)) < 0.45,
              act: () => {
                this.floor = f.id;
                this.hoverText = "";
                this.refresh();
              },
            }))
          : []),
      ],
    };
  }
  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
}
