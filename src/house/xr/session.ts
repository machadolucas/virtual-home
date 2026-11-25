import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room, Selection, Vec3 } from "../model/types";
import type { ImmersiveMode } from "./presentation";
import { saveModelFix, snapshotModelFixView } from "../modelFixApi";
import { pointInFootprint } from "../model/geometry2d";
import { captureEye } from "./captureEye";
import { MixedPilot } from "./mixedPilot";
import { HeadsetPanel, type PanelPage } from "./panel";
import { HeadsetEquipment } from "./equipment";
import { roomLanding, teleport, turnAroundHead } from "./navigation";

import { WalkWorld } from "./walkWorld";
import { EquipmentPicker, HAND_AIM_MS, stickAxes, stickIntent, TeleportArc } from "./travel";
import { FrameBudget, WalkAppearance } from "./visuals";
import { type FrameArea } from "./frameLog";
import { HandHints } from "./handHints";
import { InputBeams, pulse } from "./pointers";

interface FrameOptions {
  motion: boolean;
  rates: { supply: number; extract: number };
  fans: string;
}
type Page = "home" | "destinations" | "equipment" | "mixed" | "comfort";
type Press = {
  kind: "panel" | "equipment" | "wrist" | "travel" | "mixed" | "empty";
  id?: string;
  since: number;
};

/** A separate tracked camera lets the existing desktop rig retain its target, zoom and projection. */
export class HouseSession {
  readonly rig = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.05, 350);
  private readonly head = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();
  private readonly poseMatrix = new THREE.Matrix4();
  private readonly ray = new THREE.Raycaster();
  private readonly panel = new HeadsetPanel();
  private readonly ui = new THREE.Group();
  private readonly beams = new InputBeams();
  private readonly inputHints: HandHints | null;
  private readonly arc = new TeleportArc();
  private readonly picker = new EquipmentPicker();
  private readonly worldHead = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly movement = new THREE.Vector3();
  private world: WalkWorld | null = null;
  private appearance: WalkAppearance | null = null;
  private pickables: readonly THREE.Object3D[] | null = null;
  private readonly budget: FrameBudget;
  private low = false;
  private area: FrameArea = "House";
  private locatedAt = 0;
  private presses = new Map<XRInputSource, Press>();
  private stickSource: XRInputSource | null = null;
  private nextSample: XRInputSource | null = null;
  private sticksNeutral = true;
  private walkEnabled = true;
  private hoverNames = new Map<string, string>();
  private placements: readonly unknown[] | null = null;
  private readonly fade = new THREE.Mesh(
    new THREE.SphereGeometry(0.29, 14, 10),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private fadeStart: number | null = null;
  private moveAtBlack: (() => void) | null = null;
  private readonly mixed: MixedPilot | null;
  private equipment: HeadsetEquipment | null = null;
  private scene: THREE.Scene;
  private readonly previousBackground: THREE.Scene["background"];
  private firstPose = true;
  private placeMenu = true;
  private queuedCapture = false;
  private uploading = false;
  private retrySave: (() => Promise<unknown>) | null = null;
  private notice = "";
  private page: Page;
  private alive = true;
  private lastMenu = 0;
  private readonly destinations: Array<{ room: Room; position: Vec3 }>;
  private savedControls: boolean;

  constructor(
    private runtime: HouseRuntime,
    readonly session: XRSession,
    readonly mode: ImmersiveMode,
    private space: XRReferenceSpace,
  ) {
    this.page = mode === "vr" ? "home" : "mixed";
    this.budget = new FrameBudget(session);
    this.inputHints = mode === "vr" ? new HandHints() : null;
    if (this.inputHints) this.ui.add(this.inputHints.group);
    try {
      this.walkEnabled = localStorage.getItem("vh.xr.stickWalking") !== "off";
    } catch {
      /* storage is optional */
    }
    this.mixed = mode === "vr" ? null : new MixedPilot(runtime, session, space, mode);
    this.scene = this.mixed?.scene ?? runtime.scene!;
    this.previousBackground = this.scene.background;
    if (!this.mixed) this.scene.background = new THREE.Color(0x93a6b2);
    this.destinations = [...runtime.manifest!.rooms.values()].flatMap((room) => {
      const position = roomLanding(room);
      return position ? [{ room, position }] : [];
    });
    this.rig.add(this.camera, this.ui);
    this.ui.add(this.panel.mesh, this.beams.group, this.fade);
    this.fade.renderOrder = 10000;
    this.fade.visible = false;
    this.scene.add(this.rig, this.arc.group);
    this.panel.mesh.visible = !!this.mixed;
    this.savedControls = runtime.controls?.enabled ?? true;
    runtime.setControlsEnabled(false);
    runtime.store.setState({ immersiveMode: mode });
    session.addEventListener("selectstart", this.start);
    session.addEventListener("select", this.select);
    session.addEventListener("selectend", this.end);
    session.addEventListener("inputsourceschange", this.resetInput);
    session.addEventListener("visibilitychange", this.resetInput);
    space.addEventListener?.("reset", this.resetInput);
    session.addEventListener("squeeze", this.toggleMenu);
  }

  private recall = () => {
    this.placeMenu = true;
    this.panel.mesh.visible = true;
    this.lastMenu = 0;
  };
  private home = () => {
    this.mixed?.home();
    this.equipment?.dispose();
    this.equipment = null;
    this.page = this.mixed ? "mixed" : "home";
    this.lastMenu = 0;
  };
  private capture = () => {
    if (this.uploading || this.queuedCapture) return;
    if (this.retrySave) {
      void this.save(this.retrySave);
      return;
    }
    this.queuedCapture = true;
  };
  private async save(upload: () => Promise<unknown>) {
    this.uploading = true;
    this.notice = "Saving capture…";
    try {
      await upload();
      this.retrySave = null;
      this.notice = "Capture saved to pending model fixes.";
    } catch (error) {
      this.retrySave = upload;
      this.notice = `${error instanceof Error ? error.message : "Capture upload failed"}. Select Capture to retry.`;
    } finally {
      this.uploading = false;
      this.lastMenu = 0;
    }
  }
  private menu(options: FrameOptions): PanelPage {
    let menu: PanelPage;
    if (this.mixed) menu = this.mixed.menu(options.fans, this.capture);
    else if (this.page === "destinations")
      menu = {
        title: "Rooms and floors",
        lines: [],
        rows: this.destinations.map(({ room, position }) => ({
          label: `${this.runtime.store.getState().labelPreferences.names[room.id] ?? room.name} · ${this.runtime.manifest!.floors.get(room.floorId)?.name ?? ""}`,
          act: () => this.travelTo(position),
        })),
      };
    else if (this.page === "equipment" && this.equipment) {
      menu = this.equipment.menu();
      menu.rows.unshift({ label: "Capture model fix", act: this.capture });
    } else if (this.page === "comfort")
      menu = {
        title: "Movement and comfort",
        lines: [this.budget.label],
        rows: [
          {
            label: this.walkEnabled ? "Stick walking · on" : "Stick walking · off",
            act: () => {
              this.walkEnabled = !this.walkEnabled;
              try {
                localStorage.setItem("vh.xr.stickWalking", this.walkEnabled ? "on" : "off");
              } catch {
                /* optional */
              }
            },
          },
          { label: "Turn left 30°", act: () => this.turn(1) },
          { label: "Turn right 30°", act: () => this.turn(-1) },
          { label: "Try 90 Hz", act: this.budget.canTry90 ? () => this.budget.try90() : undefined },
        ],
      };
    else {
      const garage = this.destinations.find(
        (d) =>
          d.room.kind === "room" &&
          /garage/i.test(this.runtime.manifest!.buildings.get(d.room.buildingId ?? "")?.name ?? ""),
      );
      menu = {
        title: "Virtual Home",
        lines: [
          "Left stick walks. Right stick forward aims; release to land. Point and trigger or pinch to inspect.",
        ],
        rows: [
          { label: "Yard", act: this.world?.yard ? () => this.travelTo(this.world!.yard!) : undefined },
          ...(garage ? [{ label: "Garage", act: () => this.travelTo(garage.position) }] : []),
          {
            label: "Rooms and floors",
            act: () => {
              this.page = "destinations";
            },
          },
          {
            label: "Movement and comfort",
            act: () => {
              this.page = "comfort";
            },
          },
          { label: "Capture model fix", act: this.capture },
          {
            label: "Close menu",
            act: () => {
              this.panel.mesh.visible = false;
            },
          },
        ],
      };
    }
    if (this.notice) menu.lines.unshift(this.notice);
    return menu;
  }
  private turn(sign: number) {
    this.move(() => turnAroundHead(this.rig, this.head, (sign * Math.PI) / 6));
  }
  private move(action: () => void) {
    if (this.fadeStart !== null) return;
    this.fadeStart = performance.now();
    this.moveAtBlack = action;
    this.fade.visible = true;
  }
  private rayFrom(frame: XRFrame, source: XRInputSource) {
    const pose = frame.getPose(source.targetRaySpace, this.space);
    if (!pose || pose.emulatedPosition) return false;
    this.poseMatrix.fromArray(pose.transform.matrix).premultiply(this.rig.matrixWorld);
    this.ray.ray.origin.setFromMatrixPosition(this.poseMatrix);
    this.ray.ray.direction.set(0, 0, -1).transformDirection(this.poseMatrix);
    return true;
  }
  private travelTo(position: Vec3) {
    const dest = this.world?.landing(new THREE.Vector3(...position), this.head.y);
    if (!dest) {
      this.notice = "There is no clear standing space at this destination.";
      return;
    }
    this.home();
    this.panel.mesh.visible = false;
    this.move(() => teleport(this.rig, this.head, dest));
  }

  private resetInput = () => {
    this.inputHints?.hide();
    this.panel.cancel();
    this.presses.clear();
    this.nextSample = null;
    this.stickSource = null;
    this.arc.clear();
    this.sticksNeutral = false;
    this.moveAtBlack = null;
    this.fadeStart = null;
    this.fade.visible = false;
    this.budget.resetClock();
  };
  private toggleMenu = () => {
    if (this.session.visibilityState !== "visible") return;
    this.resetInput();
    const toMenu = this.movement.subVectors(this.panel.mesh.position, this.head);
    const nearby = toMenu.lengthSq() < 2.25;
    const inView =
      this.forward.set(0, 0, -1).applyQuaternion(this.orientation).dot(toMenu.normalize()) > 0.65;
    if (this.panel.mesh.visible && nearby && inView) this.panel.mesh.visible = false;
    else this.recall();
  };
  private wristHit(source: XRInputSource) {
    return (
      !!source.hand &&
      this.beams.wrist.mesh.visible &&
      this.ray.intersectObject(this.beams.wrist.mesh, false)[0]
    );
  }
  private start = (e: XRInputSourceEvent) => {
    const source = e.inputSource;
    if (
      !this.alive ||
      this.session.visibilityState !== "visible" ||
      this.stickSource ||
      this.fadeStart !== null
    )
      return;
    const hasRay = this.rayFrom(e.frame, source);
    const press: Press = { kind: "empty", since: performance.now() };
    const hit = hasRay ? this.panel.hit(this.ray) : null;
    if (hit) {
      press.kind = "panel";
      this.panel.start(source, hit);
    } else if (hasRay && this.wristHit(source)) press.kind = "wrist";
    else if (this.mixed) {
      press.kind = "mixed";
      if (hasRay) press.id = this.mixed.overlay?.pick(this.ray.ray)?.id;
    } else if (hasRay && this.world) {
      const target = this.picker.target(this.world, this.ray, this.runtime.markers);
      if (target?.id) {
        press.kind = "equipment";
        press.id = target.id;
      } else if (source.hand && target?.floor && !this.presses.size) press.kind = "travel";
    }
    this.presses.set(source, press);
  };
  private end = (e: XRInputSourceEvent) => {
    if (this.panel.owns(e.inputSource)) this.panel.cancel();
    if (this.presses.get(e.inputSource)?.kind === "travel") this.arc.clear();
    this.presses.delete(e.inputSource);
  };
  private select = (e: XRInputSourceEvent) => {
    const source = e.inputSource,
      press = this.presses.get(source);
    if (!press || !this.alive || this.session.visibilityState !== "visible") return;
    const hasRay = this.rayFrom(e.frame, source);
    this.lastMenu = 0;
    if (press.kind === "panel") {
      if (this.panel.end(source, hasRay ? this.panel.hit(this.ray, true) : null)) pulse(source);
    } else if (press.kind === "wrist") {
      if (hasRay && this.wristHit(source)) this.toggleMenu();
    } else if (hasRay && this.panel.hit(this.ray)) {
      // Press began in the world and ended on UI. Neither target owns a click.
    } else if (press.kind === "travel" && hasRay && performance.now() - press.since >= HAND_AIM_MS) {
      const p = this.arc.landing;
      if (p && this.arc.group.visible) this.move(() => teleport(this.rig, this.head, p));
      this.arc.clear();
    } else if (press.kind === "equipment" && this.world && hasRay) {
      const hit = this.picker.target(this.world, this.ray, this.runtime.markers);
      const item =
        hit?.id === press.id && this.runtime.store.getState().placements.find((p) => p.id === hit?.id);
      if (item) {
        this.equipment?.dispose();
        this.equipment = new HeadsetEquipment(item);
        this.notice = "";
        this.page = "equipment";
        this.recall();
        pulse(source);
      }
    } else if (press.kind === "mixed" && this.mixed) {
      if (!press.id || (hasRay && this.mixed.overlay?.pick(this.ray.ray)?.id === press.id))
        this.nextSample = source;
    }
    this.presses.delete(source);
  };
  private syncWorld() {
    const index = this.runtime.index;
    if (!index || this.mixed || this.pickables === index.pickables) return;
    this.world?.dispose();
    this.appearance?.dispose();
    this.pickables = index.pickables;
    this.world = new WalkWorld(index);
    this.appearance = new WalkAppearance(index);
    this.appearance.detail(!this.low);
    this.scene.add(this.appearance.sky);
  }
  private locomotion(frame: XRFrame, sources: XRInputSource[], dt: number) {
    if (!this.world || this.fadeStart !== null) return;
    const right = sources.find((s) => !s.hand && s.handedness === "right");
    const axis = stickAxes(right?.gamepad),
      intent = stickIntent(axis.x, axis.y);
    const neutral = Math.max(Math.abs(axis.x), Math.abs(axis.y)) < 0.32;
    if (this.stickSource) {
      if (
        right !== this.stickSource ||
        !this.rayFrom(frame, right) ||
        axis.y > 0.5 ||
        Math.abs(axis.x) > 0.88 ||
        this.presses.size
      ) {
        this.stickSource = null;
        this.arc.clear();
      } else if (neutral) {
        const p = this.arc.landing;
        if (p) {
          this.move(() => teleport(this.rig, this.head, p));
          pulse(right);
        }
        this.stickSource = null;
        this.arc.clear();
        this.sticksNeutral = true;
      } else this.arc.aim(this.world, this.ray.ray, this.head.y);
      return;
    }
    if (neutral) this.sticksNeutral = true;
    if (this.presses.size) return;
    if (right && this.sticksNeutral && intent) {
      this.sticksNeutral = false;
      if (intent === "aim" && this.rayFrom(frame, right)) {
        if (!this.panel.hit(this.ray)) {
          this.stickSource = right;
          this.arc.aim(this.world, this.ray.ray, this.head.y);
        }
      } else if (intent !== "aim") this.turn(intent === "left" ? 1 : -1);
      return;
    }
    if (!this.walkEnabled) return;
    const left = stickAxes(sources.find((s) => !s.hand && s.handedness === "left")?.gamepad);
    const magnitude = Math.hypot(left.x, left.y);
    if (magnitude < 0.16) return;
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation).applyQuaternion(this.rig.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.0001) return;
    this.forward.normalize();
    const speed = (Math.min(1, (magnitude - 0.16) / 0.84) * 1.55 * dt) / magnitude;
    const dx = (this.forward.x * -left.y - this.forward.z * left.x) * speed;
    const dz = (this.forward.z * -left.y + this.forward.x * left.x) * speed;
    const feet = this.movement.copy(this.worldHead);
    feet.y = this.rig.position.y;
    const next =
      this.world.step(feet, dx, dz, this.head.y) ??
      (dx ? this.world.step(feet, dx, 0, this.head.y) : null) ??
      this.world.step(feet, 0, dz, this.head.y);
    if (next) teleport(this.rig, this.head, next);
  }
  private updateWrist(frame: XRFrame, sources: XRInputSource[]) {
    const wrist = this.beams.wrist.mesh;
    const hands = sources.filter((s) => s.hand);
    const left = hands.find((s) => s.handedness === "left");
    const joint = left?.hand?.get("wrist");
    const pose = joint && frame.getJointPose?.(joint, this.space);
    wrist.visible = hands.length > 0;
    if (!wrist.visible) return;
    if (pose && !pose.emulatedPosition && hands.length > 1) {
      const p = pose.transform.position;
      wrist.position.set(p.x, p.y + 0.06, p.z);
    } else wrist.position.set(-0.2, -0.24, -0.58).applyQuaternion(this.orientation).add(this.head);
    wrist.quaternion.copy(this.orientation);
    wrist.updateWorldMatrix(true, false);
  }
  private pointers(frame: XRFrame, sources: XRInputSource[], now: number) {
    this.beams.clear();
    this.updateWrist(frame, sources);
    const placed = this.runtime.store.getState().placements;
    if (placed !== this.placements) {
      this.hoverNames = new Map(placed.map((p) => [p.id, p.name]));
      this.placements = placed;
    }
    for (let i = 0; i < this.beams.slots.length; i++) {
      const source = sources[i],
        slot = this.beams.slots[i]!;
      if (source && this.mixed)
        slot.probe.visible = !!this.mixed.probePosition(frame, source, slot.probe.position);
      if (!source || !this.rayFrom(frame, source)) {
        this.panel.cursor(i, null);
        if (source && this.panel.owns(source)) this.panel.cancel();
        continue;
      }
      const pose = frame.getPose(source.targetRaySpace, this.space)!;
      const { line, dot, label } = slot;
      this.poseMatrix.fromArray(pose.transform.matrix).decompose(line.position, line.quaternion, line.scale);
      const hit = this.panel.hit(this.ray);
      this.panel.cursor(i, hit);
      if (this.panel.owns(source)) this.panel.drag(source, this.panel.hit(this.ray, true));
      const press = this.presses.get(source);
      if (press?.kind === "travel" && this.world && now - press.since >= HAND_AIM_MS) {
        if (hit || this.wristHit(source)) this.arc.clear();
        else this.arc.aim(this.world, this.ray.ray, this.head.y);
        continue;
      }
      if (this.stickSource === source) continue;
      let point = hit?.point,
        text = "",
        active = !!hit?.row?.act;
      if (!hit) {
        const wrist = this.wristHit(source);
        if (wrist) {
          point = wrist.point;
          active = true;
        } else if (this.world) {
          const target = this.picker.target(this.world, this.ray, this.runtime.markers);
          point = target?.point;
          if (target?.id) {
            slot.highlight.equipment(target.mesh, target.instanceId);
            text = this.hoverNames.get(target.id) ?? "Equipment";
            active = true;
          } else if (source.hand && target?.floor) active = true;
        } else if (this.mixed?.overlay) {
          const route = this.mixed.overlay.pick(this.ray.ray);
          if (route) {
            point = this.ray.ray.at(route.distance, new THREE.Vector3());
            slot.highlight.route(this.mixed.overlay.group, route.segment, route.approximate);
            text = route.label;
            active = true;
          }
        }
      }
      line.visible = true;
      line.scale.z = point ? this.ray.ray.origin.distanceTo(point) : 0.65;
      line.material.opacity = active ? 0.88 : 0.36;
      if (point) {
        dot.position.copy(this.rig.worldToLocal(point.clone()));
        dot.visible = true;
        dot.scale.setScalar(Math.min(4, Math.max(0.65, line.scale.z)) * 0.8);
        dot.material.color.setHex(active ? 0x6dffcf : 0xc8d9d8);
        if (text) {
          label.write(text);
          label.mesh.visible = true;
          label.mesh.position.copy(dot.position);
          const scale = Math.max(0.65, Math.min(3, line.scale.z));
          label.mesh.position.y += 0.044 * scale;
          label.mesh.quaternion.copy(this.orientation);
          label.mesh.scale.setScalar(scale);
        }
      }
    }
  }
  frame(gl: THREE.WebGLRenderer, frame: XRFrame, delta: number, options: FrameOptions) {
    this.mixed?.frame(frame, delta, options.motion, options.rates);
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || this.session.visibilityState !== "visible" || viewer.emulatedPosition) {
      this.resetInput();
      this.beams.clear();
      if (this.mixed) gl.clear();
      return;
    }
    const { position, orientation } = viewer.transform;
    this.head.set(position.x, position.y, position.z);
    this.orientation.set(orientation.x, orientation.y, orientation.z, orientation.w);
    const now = performance.now(),
      dt = Math.min(Math.max(delta, 0), 0.05);
    this.syncWorld();
    if (this.budget.low !== this.low) {
      this.low = this.budget.low;
      this.appearance?.detail(!this.low);
      this.runtime.store.setState({ immersiveLowDetail: this.low });
    }
    if (this.firstPose && this.world && this.pickables?.length) {
      const start = this.destinations.find((d) => d.room.kind === "room") ?? this.destinations[0];
      const landing = start && this.world.landing(new THREE.Vector3(...start.position), this.head.y);
      if (landing) teleport(this.rig, this.head, landing);
      this.firstPose = false;
    }
    this.worldHead.copy(this.head).applyMatrix4(this.rig.matrixWorld);
    this.world?.updateDoors(this.worldHead, dt);
    const sources = Array.from(this.session.inputSources).filter(
      (s) => s.targetRayMode === "tracked-pointer",
    );
    this.inputHints?.update(frame, this.space, sources);
    this.locomotion(frame, sources, dt);
    if (this.placeMenu) {
      this.panel.place(this.head, this.orientation);
      this.placeMenu = false;
    }
    if (this.fadeStart !== null) {
      const age = now - this.fadeStart;
      if (age >= 90 && this.moveAtBlack) {
        this.moveAtBlack();
        this.moveAtBlack = null;
      }
      this.fade.material.opacity = Math.max(0, Math.min(1, age / 90, (230 - age) / 110));
      this.fade.position.copy(this.head);
      if (age >= 230) {
        this.fadeStart = null;
        this.fade.visible = false;
      }
    }
    this.rig.updateMatrixWorld(true);
    this.worldHead.copy(this.head).applyMatrix4(this.rig.matrixWorld);
    this.appearance?.sky.position.copy(this.worldHead);
    this.appearance?.updateSky(this.scene, now);
    if (!this.locatedAt || now - this.locatedAt > 500) {
      if (this.mixed) this.area = this.mode === "survey" ? "Room survey" : "Mixed reality";
      else {
        const room = this.destinations.find(
          (d) =>
            Math.abs(d.room.floorElevation - this.rig.position.y) < 0.6 &&
            pointInFootprint(this.worldHead.x, this.worldHead.z, d.room.footprint),
        );
        this.area = room
          ? /garage/i.test(this.runtime.manifest!.buildings.get(room.room.buildingId ?? "")?.name ?? "")
            ? "Garage"
            : "House"
          : "Yard";
      }
      this.locatedAt = now;
    }
    this.budget.tick(now, this.area);
    if (this.panel.mesh.visible && (!this.lastMenu || now - this.lastMenu > 200)) {
      this.panel.draw(this.menu(options), this.home, () => {
        void this.session.end();
      });
      this.lastMenu = now;
    }
    if (this.nextSample && this.mixed) {
      const source = this.nextSample;
      this.nextSample = null;
      if (sources.includes(source))
        this.mixed.select(frame, source, this.rayFrom(frame, source) ? this.ray.ray : null);
    }
    this.pointers(frame, sources, now);
    if (this.queuedCapture) {
      this.queuedCapture = false;
      const view = viewer.views[0];
      if (view) this.takeCapture(gl, view);
    }
    gl.render(this.scene, this.camera);
  }
  private takeCapture(gl: THREE.WebGLRenderer, view: XRView) {
    if (this.mixed && !this.mixed.overlay?.group.visible) {
      this.notice = "Verify alignment before capturing the overlay.";
      return;
    }
    const eye = new THREE.PerspectiveCamera();
    eye.projectionMatrix.fromArray(view.projectionMatrix);
    eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    const pose = new THREE.Matrix4().fromArray(view.transform.matrix).premultiply(this.rig.matrixWorld);
    pose.decompose(eye.position, eye.quaternion, eye.scale);
    eye.updateMatrixWorld();
    const selection: Selection | null = this.mixed?.selectedRoute
      ? { kind: "route", id: this.mixed.selectedRoute.id }
      : this.equipment
        ? { kind: "equipment", id: this.equipment.placement.id }
        : null;
    if (this.mixed?.overlay) pose.premultiply(this.mixed.overlay.group.matrix.clone().invert());
    const pos = new THREE.Vector3().setFromMatrixPosition(pose);
    const quat = new THREE.Quaternion().setFromRotationMatrix(pose);
    const camera = {
      position: pos.toArray(),
      target: new THREE.Vector3(0, 0, -1).applyQuaternion(quat).add(pos).toArray(),
      projection: "perspective" as const,
      quaternion: quat.toArray(),
    };
    const room =
      this.mixed?.room ??
      this.destinations.find(
        ({ room }) =>
          Math.abs(room.floorElevation - this.rig.position.y) < 0.45 &&
          pointInFootprint(pos.x, pos.z, room.footprint),
      )?.room;
    const snapshot = snapshotModelFixView(this.runtime, this.mode === "vr" ? "vr" : "mr", camera, {
      selection,
      overlay: this.mixed?.filter,
      floorId: room?.floorId ?? this.equipment?.placement.floorId,
      roomId: room?.id ?? this.equipment?.placement.roomId,
    });
    const requestId = crypto.randomUUID();
    this.ui.visible = false;
    try {
      // The image and model-space pose are sampled in the same XR animation frame.
      const blob = captureEye(gl, this.scene, eye);
      this.uploading = true;
      void blob
        .then((image) =>
          this.save(() => saveModelFix(this.runtime.base, { ...snapshot, images: [image] }, requestId)),
        )
        .catch(() => {
          this.notice = "Image encoding failed. Capture again.";
          this.uploading = false;
        });
    } catch {
      this.notice = "Could not capture this frame. Try again.";
    } finally {
      this.ui.visible = true;
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.session.removeEventListener("select", this.select);
    this.session.removeEventListener("selectstart", this.start);
    this.session.removeEventListener("selectend", this.end);
    this.session.removeEventListener("squeeze", this.toggleMenu);
    this.session.removeEventListener("inputsourceschange", this.resetInput);
    this.session.removeEventListener("visibilitychange", this.resetInput);
    this.space.removeEventListener?.("reset", this.resetInput);
    this.budget.log.save(this.runtime.userId);
    this.world?.dispose();
    this.appearance?.dispose();
    this.arc.dispose();
    this.beams.dispose();
    this.inputHints?.dispose();
    this.equipment?.dispose();
    this.mixed?.dispose();
    this.rig.removeFromParent();
    this.scene.background = this.previousBackground;
    this.panel.dispose();
    this.fade.geometry.dispose();
    this.fade.material.dispose();
    this.runtime.store.setState({ immersiveMode: null, immersiveLowDetail: false });
    this.runtime.setControlsEnabled(this.savedControls);
    this.runtime.invalidate();
  }
}
