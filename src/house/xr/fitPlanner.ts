import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Furnishing, Room } from "../model/types";
import { fitPresets, type FitDraft, type FitRecord } from "../model/fitProposal";
import { pointInFootprint, poleOfInaccessibility } from "../model/geometry2d";
import { equipmentCollisionShape, equipmentPlacementEnvelope } from "../scene/equipmentPlacement";
import {
  clearFurnishingCollisionCache,
  furnishingCollisionShape,
  wallTriangles,
  type PlacementEnvelope,
} from "../scene/furnishingPlacement";
import { assessFit, fitBody, fitClearance, fitOpening, type FitCheck, type FitContact, type FitObject, type FitWall } from "./fitGeometry";
import type { PanelPage, PanelRow } from "./panel";

const cm = (m: number) => Math.round(m * 100) + " cm";
const describe = (c: FitCheck) =>
  !c.bodyClear
    ? "Body intersects model"
    : !c.openingClear
      ? "Opening obstructed"
      : (c.beyond ? "≥ " : "") + cm(c.gap) + " beyond opening";
function ghost(color: number, alpha: number, depthTest = true) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: alpha, depthTest, depthWrite: false }),
  );
  mesh.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color, depthTest }),
    ),
  );
  return mesh;
}
const contactColor = 0xff7661;
const openingReadout = (spec: FitDraft["spec"], fraction: number) =>
  spec.opening === "Drawer" ? `${Math.floor(spec.reach * fraction * 1000) / 10} cm` :
    `${Math.floor(fraction * 900) / 10}°`;
function place(mesh: THREE.Mesh, box: PlacementEnvelope) {
  mesh.position.set(box.position[0], box.position[1] + box.heightM / 2, box.position[2]);
  mesh.scale.set(box.widthM, box.heightM, box.depthM);
  mesh.rotation.y = THREE.MathUtils.degToRad(box.rotationYDeg);
}

export class FitPlanner {
  readonly group = new THREE.Group();
  readonly room: Room;
  private readonly body = ghost(0x61f4c4, 0.19);
  private readonly leaf = ghost(0xffc47f, 0.34);
  private readonly other = ghost(0x9eb4ef, 0.055);
  private readonly preview = ghost(0xf6f3dd, 0.1);
  private readonly clearance = ghost(0x7fdbe7, 0.065);
  private readonly obstacle = new THREE.Group();
  private readonly marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 12, 8),
    new THREE.MeshBasicMaterial({ color: contactColor, depthTest: false, depthWrite: false }),
  );
  private draft: FitDraft;
  private screen: "main" | "size" | "saved" | "replace" = "main";
  private checks: [FitCheck, FitCheck] | null = null;
  private walls: FitWall[] = [];
  private obstacles: FitObject[] = [];
  private replacementBoxes: PlacementEnvelope[] = [];
  private contact: FitContact | null = null;
  private proposals: FitRecord[] = [];
  private available: { id: string; kind: "furnishing" | "equipment"; name: string }[] = [];
  private dimension: "width" | "depth" | "height" | "reach" = "width";
  private mark = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private disposed = false;
  private busy = false;
  private message = "";
  private loadFailed = false;
  private opening = 1;
  private animationStart: number | null = null;
  private animating = false;
  private requestId = crypto.randomUUID();
  private readonly abort = new AbortController();
  moving = false;
  constructor(
    private runtime: HouseRuntime,
    room: Room,
    private exit: () => void,
    private recall: () => void,
  ) {
    this.room = room;
    const {
      point: [x, z],
    } = poleOfInaccessibility(room.footprint);
    this.draft = {
      spec: { ...fitPresets.Washer },
      arrangements: [
        { x, z, yaw: 0 },
        { x, z, yaw: 90 },
      ],
      preferred: "A",
    };
    this.group.name = "vh-fit-planner";
    this.leaf.name = "vh-fit-opening";
    this.clearance.name = "vh-fit-clearance";
    this.obstacle.name = "vh-fit-obstacle";
    this.marker.name = "vh-fit-first-contact";
    this.marker.renderOrder = 10;
    this.group.add(
      this.body,
      this.leaf,
      this.other,
      this.preview,
      this.clearance,
      this.obstacle,
      this.marker,
    );
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.preview.visible = false;
    this.draw();
    void this.load();
  }
  private async load() {
    this.message = "Loading recorded obstacles and proposals…";
    this.loadFailed = false;
    try {
      const get = async (path: string) => {
        const res = await fetch(this.runtime.base + path, { signal: this.abort.signal, cache: "no-store" });
        if (!res.ok) throw Error();
        return res.json();
      };
      const [f, p] = (await Promise.all([
        get("/furnishings"),
        get("/fit-proposals?roomId=" + encodeURIComponent(this.room.id)),
      ])) as [{ furnishings: Furnishing[] }, { proposals: FitRecord[] }];
      if (this.disposed) return;
      if (this.runtime.index) {
        const index = this.runtime.index;
        clearFurnishingCollisionCache(index);
        const state = this.runtime.store.getState();
        this.walls = wallTriangles(index, state.immersiveMode === "mr" ? state.explode : undefined)
          .filter(
            (wall) =>
              wall.bounds.max.y >= this.room.floorElevation &&
              wall.bounds.min.y <= this.room.floorElevation + (this.room.ceilingHeight ?? 3),
          )
          .map((wall, i): FitWall => {
            const surface = wall.surfaceId ? index.manifest.surfaces.get(wall.surfaceId) : undefined;
            const element = surface?.elementId ? index.manifest.elements.get(surface.elementId) : undefined;
            const name = [
              element?.properties?.name,
              element?.properties?.label,
              element?.label,
              surface?.label,
            ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
            const sid = wall.surfaceId ?? `wall-${i + 1}`;
            return {
              ...wall,
              id: sid,
              kind: "wall",
              name: name?.trim() || `${element?.kind === "door" ? "Door" : "Wall"} · ${sid}`,
            };
          });
      }
      this.available = [
        ...f.furnishings
          .filter((item) => item.roomId === this.room.id && item.kind !== "rug")
          .map((item) => ({ id: item.id, kind: "furnishing" as const, name: item.name })),
        ...this.runtime.store
          .getState()
          .placements.filter(
            (item) =>
              item.roomId === this.room.id &&
              item.mount.kind === "floor" &&
              item.symbol !== "floor_heating",
          )
          .map((item) => ({ id: item.id, kind: "equipment" as const, name: item.name })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      const furnishings = f.furnishings.filter((item) => item.floorId === this.room.floorId);
      const equipment = this.runtime.store
        .getState()
        .placements.filter((item) => item.floorId === this.room.floorId && item.symbol !== "floor_heating");
      this.replacementBoxes = [...furnishings, ...equipment.map(equipmentPlacementEnvelope)];
      this.obstacles = [
        ...furnishings.flatMap((item): FitObject[] => {
          const shape = furnishingCollisionShape(item);
          return shape ? [{ ...shape, name: item.name, kind: "furnishing" }] : [];
        }),
        ...equipment.flatMap((item): FitObject[] => {
          const shape = equipmentCollisionShape(item);
          return shape ? [{ ...shape, name: item.name, kind: "equipment" }] : [];
        }),
      ];
      this.proposals = p.proposals;
      this.ready = true;
      this.message = "";
      this.recheck();
    } catch {
      if (!this.disposed) {
        this.message = "Obstacle records unavailable. Retry to measure clearance.";
        this.loadFailed = true;
      }
    }
  }
  private get i(): 0 | 1 {
    return this.draft.preferred === "A" ? 0 : 1;
  }
  private get maxOpening() {
    const check = this.checks?.[this.i];
    return check?.bodyClear ? check.openingLimit : 0;
  }
  private recheck() {
    if (this.ready) {
      const obstacles = this.obstacles.filter((o) => o.id !== this.draft.replaces?.id);
      const check = (index: 0 | 1) =>
        assessFit(this.draft.arrangements[index], this.draft.spec, this.room, obstacles, this.walls);
      this.checks = [check(0), check(1)];
    }
    this.draw();
  }
  private edit() {
    const mark = JSON.stringify(this.draft);
    if (mark === this.mark) return;
    this.mark = mark;
    this.requestId = crypto.randomUUID();
    this.animating = false;
    this.message = "";
    this.checks = null;
    this.draw();
    // Render direct manipulation immediately. Recheck the swept volumes after the hand settles.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recheck();
    }, 120);
  }
  private draw() {
    const { spec, arrangements } = this.draft,
      y = this.room.floorElevation;
    const p = arrangements[this.i];
    place(this.body, fitBody(p, spec, y));
    const check = this.checks?.[this.i];
    const opening = this.animating ? this.opening : Math.min(this.opening, this.maxOpening);
    place(this.leaf, fitOpening(p, spec, y, opening));
    place(this.other, fitBody(arrangements[this.i === 0 ? 1 : 0], spec, y));
    this.body.material.color.setHex(check?.bodyClear === false ? contactColor : 0x61f4c4);
    this.leaf.material.color.setHex(
      check?.openingClear === false && opening >= this.maxOpening ? contactColor : 0xffc47f,
    );
    this.leaf.visible = !!check && (spec.opening !== "Drawer" || opening > 0.001);
    this.clearance.visible = !!check?.clearanceContact && opening >= 0.999 && check.gap > 0.01;
    if (this.clearance.visible && check) place(this.clearance, fitClearance(p, spec, y, check.gap));
    this.highlight(check?.bodyContact ?? check?.openingContact ?? check?.clearanceContact ?? null);
    this.marker.visible = !!this.contact && (!this.animating || opening >= this.maxOpening);
  }
  private highlight(contact: FitContact | null) {
    if (contact === this.contact) return;
    for (const child of this.obstacle.children) this.disposeMesh(child);
    this.obstacle.clear();
    this.contact = contact;
    if (!contact) return;
    const { obstacle, part, point } = contact;
    this.marker.position.fromArray(point);
    if (part) {
      const shape = ghost(contactColor, 0.17, false);
      place(shape, part);
      this.obstacle.add(shape);
      return;
    }
    const material = new THREE.LineBasicMaterial({
      color: contactColor,
      depthTest: false,
      depthWrite: false,
    });
    if (obstacle.kind === "wall") {
      const triangles = new THREE.BufferGeometry().setFromPoints([...obstacle.vertices]);
      this.obstacle.add(new THREE.LineSegments(new THREE.EdgesGeometry(triangles), material));
      triangles.dispose();
    } else if (obstacle.kind === "edge") {
      const { a, b } = obstacle;
      const positions = [new THREE.Vector3(a[0], point[1], a[1]), new THREE.Vector3(b[0], point[1], b[1])];
      this.obstacle.add(
        new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(positions), material),
      );
    } else if (obstacle.kind === "ceiling") {
      const box = fitBody(this.draft.arrangements[this.i], this.draft.spec, obstacle.elevation);
      const tile = ghost(contactColor, 0.12, false);
      place(tile, { ...box, heightM: 0.006 });
      material.dispose();
      this.obstacle.add(tile);
    }
  }
  transform(modelToWorld: THREE.Matrix4 | null, now = performance.now()) {
    this.group.visible = !!modelToWorld;
    if (!modelToWorld) {
      this.animating = false;
      return;
    }
    if (this.animating) {
      this.animationStart ??= now;
      this.opening = Math.min(this.maxOpening, Math.max(0, (now - this.animationStart) / 1500));
      if (this.opening >= this.maxOpening) this.animating = false;
      this.draw();
    }
    this.group.matrix.copy(modelToWorld);
    this.group.updateMatrixWorld(true);
  }
  point(ray: THREE.Ray) {
    if (!this.moving || !this.group.visible) return null;
    const local = ray.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
    if (local.direction.y >= -0.015) return null;
    const hit = local.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.room.floorElevation),
      new THREE.Vector3(),
    );
    if (!hit || !pointInFootprint(hit.x, hit.z, this.room.footprint)) return null;
    return hit;
  }
  hover(p: THREE.Vector3 | null) {
    this.preview.visible = !!p && this.moving;
    if (p)
      place(
        this.preview,
        fitBody(
          { ...this.draft.arrangements[this.i], x: p.x, z: p.z },
          this.draft.spec,
          this.room.floorElevation,
        ),
      );
  }
  commit(p: THREE.Vector3) {
    if (!this.moving || this.busy) return;
    this.draft.arrangements[this.i] = { ...this.draft.arrangements[this.i], x: p.x, z: p.z };
    this.moving = false;
    this.hover(null);
    this.edit();
    this.recall();
  }
  private async save() {
    if (this.busy || !this.ready) return;
    this.busy = true;
    this.message = "Saving preferred arrangement…";
    const draft = structuredClone(this.draft);
    try {
      const res = await fetch(this.runtime.base + "/fit-proposals", {
        method: "POST",
        signal: this.abort.signal,
        headers: { "Content-Type": "application/json", "x-vh-fit-proposal": "1" },
        body: JSON.stringify({
          requestId: this.requestId,
          roomId: this.room.id,
          fingerprint: this.runtime.store.getState().fingerprint,
          draft,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw Error(
          err.error === "replaced_item_changed"
            ? "The item being replaced changed. Choose it again."
            : "Save failed. Select Save again to retry.",
        );
      }
      const { id } = (await res.json()) as { id: string };
      this.proposals = [
        { id, draft, createdAtMs: Date.now() },
        ...this.proposals.filter((p) => p.id !== id),
      ];
      this.message = "Saved · Arrangement " + draft.preferred + " preferred";
    } catch (e) {
      if (!this.disposed)
        this.message =
          e instanceof Error && e.message.includes("again")
            ? e.message
            : "Save failed. Select Save again to retry.";
    } finally {
      this.busy = false;
    }
  }
  back = () => {
    if (this.moving || this.screen !== "main") {
      this.moving = false;
      this.hover(null);
      this.screen = "main";
      this.recall();
    } else this.exit();
  };
  menu(hide: () => void): PanelPage {
    const d = this.draft,
      s = d.spec,
      p = d.arrangements[this.i];
    const check = this.checks?.[this.i];
    const opening = Math.min(this.opening, this.maxOpening);
    const slider = (
      id: string,
      label: string,
      value: number,
      act: (v: number) => void,
      enabled = true,
    ): PanelRow => ({
      id,
      label,
      value,
      act: this.busy || !enabled ? undefined : act,
    });
    const lines = this.message ? [this.message] : [];
    if (this.screen === "saved")
      return {
        title: "Saved fit proposals",
        lines: [
          this.room.name,
          ...lines,
          ...(this.proposals.length ? [] : ["Your saved comparisons appear here."]),
        ],
        back: this.back,
        rows: this.proposals.map((item) => ({
          id: item.id,
          label: item.draft.spec.kind + " · " + item.draft.preferred + " preferred",
          detail: new Date(item.createdAtMs).toLocaleString(),
          act: () => {
            this.draft = structuredClone(item.draft);
            this.screen = "main";
            this.edit();
          },
        })),
      };
    if (this.screen === "replace")
      return {
        title: "Replace a recorded item",
        lines: ["The selected item is excluded from this comparison."],
        back: this.back,
        rows: [
          {
            label: "Add as a new item",
            active: !d.replaces,
            act: () => {
              delete d.replaces;
              this.screen = "main";
              this.edit();
            },
          },
          ...this.available.map((item) => ({
            id: item.id,
            label: item.name,
            active: d.replaces?.id === item.id,
            act: () => {
              d.replaces = { kind: item.kind, id: item.id };
              const box = this.replacementBoxes.find((o) => o.id === item.id);
              if (box && pointInFootprint(box.position[0], box.position[2], this.room.footprint)) {
                d.arrangements[this.i] = {
                  x: box.position[0],
                  z: box.position[2],
                  yaw: ((box.rotationYDeg + 540) % 360) - 180,
                };
              }
              this.screen = "main";
              this.edit();
            },
          })),
        ],
      };
    if (this.screen === "size") {
      const dimensions = (["width", "depth", "height", "reach"] as const).map((k) =>
        slider(
          k,
          (k === "reach"
            ? s.opening === "Drawer"
              ? "Drawer travel"
              : "Door width"
            : k[0]!.toUpperCase() + k.slice(1)) +
            " · " +
            cm(s[k]),
          (s[k] - 0.05) / 2.95,
          (v) => {
            this.dimension = k;
            s[k] = Math.round((0.05 + v * 2.95) * 100) / 100;
            this.edit();
          },
        ),
      );
      return {
        title: "Product dimensions",
        lines: ["Start with a preset. Set the measurements from the product drawing.", ...lines],
        back: this.back,
        rows: [
          ...Object.values(fitPresets).map((v) => ({
            id: v.kind,
            label: v.kind,
            active: s.kind === v.kind,
            act: () => {
              d.spec = { ...v };
              this.edit();
            },
          })),
          ...dimensions,
          ...([-1, 1] as const).map((sign) => ({
            id: "nudge" + sign,
            style: "choice" as const,
            label: (sign < 0 ? "−" : "+") + "1 cm",
            detail: this.dimension + " · " + cm(s[this.dimension]),
            act: () => {
              const k = this.dimension;
              s[k] = Math.min(3, Math.max(0.05, Math.round((s[k] + sign * 0.01) * 100) / 100));
              this.edit();
            },
          })),
          ...(["Left hinge", "Right hinge", "Drawer"] as const).map((opening) => ({
            id: opening,
            label: opening,
            active: s.opening === opening,
            act: () => {
              s.opening = opening;
              this.edit();
            },
          })),
        ],
      };
    }
    if (this.moving)
      return {
        title: "Place arrangement " + d.preferred,
        lines: ["Point at the room floor and click. The pale outline previews the position."],
        back: this.back,
        rows: [],
      };
    return {
      title: "Fit and clearance",
      lines: [
        this.room.name + " · " + s.kind + " · " + cm(s.width) + " × " + cm(s.depth) + " × " + cm(s.height),
        "Model estimates · " + s.opening.toLowerCase() + " · " + cm(s.reach),
        ...(check?.bodyContact
          ? [`Body overlaps ${check.bodyContact.obstacle.name}.`]
          : check?.openingContact
            ? [`Stops at ${openingReadout(s, check.openingLimit)} · ${check.openingContact.obstacle.name}`]
            : check?.clearanceContact
              ? [`${cm(check.gap)} beyond opening · ${check.clearanceContact.obstacle.name}`]
              : check?.beyond
                ? ["At least 5 m beyond the fully open front."]
                : []),
        ...lines,
      ],
      back: this.back,
      close: hide,
      rows: [
        ...(["A", "B"] as const).map((v, i) => ({
          id: v,
          label: "Arrangement " + v,
          detail: this.checks ? describe(this.checks[i]!) : this.ready ? "Measuring…" : "Awaiting records",
          active: v === d.preferred,
          style: "choice" as const,
          act: this.busy
            ? undefined
            : () => {
                d.preferred = v;
                this.edit();
              },
        })),
        {
          id: "place",
          label: "Place " + d.preferred + " on floor",
          detail: "Aim and click",
          style: "primary",
          act: this.busy
            ? undefined
            : () => {
                this.moving = true;
                hide();
              },
        },
        slider("yaw", "Rotation · " + p.yaw + "°", (p.yaw + 180) / 360, (v) => {
          p.yaw = Math.round(v * 72) * 5 - 180;
          this.edit();
        }),
        slider(
          "opening",
          "Preview opening · " + openingReadout(s, opening),
          opening,
          (v) => {
            this.animating = false;
            this.opening = Math.min(this.maxOpening, Math.max(0, v));
            this.draw();
          },
          this.maxOpening > 0,
        ),
        {
          id: "play-opening",
          label: this.animating ? "Pause opening preview" : "Play opening preview",
          act:
            !this.busy && this.maxOpening > 0
              ? () => {
                  if (this.animating) this.animating = false;
                  else {
                    this.animating = true;
                    this.opening = 0;
                    this.animationStart = null;
                  }
                  this.draw();
                }
              : undefined,
        },
        {
          label: "Place as",
          detail: this.available.find((i) => i.id === d.replaces?.id)?.name ?? "New item",
          act:
            this.busy || !this.ready
              ? undefined
              : () => {
                  this.screen = "replace";
                },
        },
        {
          label: "Product dimensions",
          act: this.busy
            ? undefined
            : () => {
                this.screen = "size";
              },
        },
        {
          label: "Save " + d.preferred + " as preferred",
          act: this.busy || !this.checks ? undefined : () => void this.save(),
        },
        {
          label: "Saved proposals",
          detail: String(this.proposals.length),
          act: this.busy
            ? undefined
            : () => {
                this.screen = "saved";
              },
        },
        ...(this.loadFailed ? [{ label: "Retry loading records", act: () => void this.load() }] : []),
      ],
    };
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.disposed = true;
    this.abort.abort();
    this.group.removeFromParent();
    this.disposeMesh(this.group);
  }
  private disposeMesh(root: THREE.Object3D) {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
  }
}
