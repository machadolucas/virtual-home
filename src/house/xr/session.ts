import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room, Selection, Vec3 } from "../model/types";
import type { ImmersiveMode } from "./presentation";
import { saveModelFix, snapshotModelFixView } from "../modelFixApi";
import type { RouteMeasurement } from "../modelFixTypes";
import { pointInFootprint } from "../model/geometry2d";
import { captureEye } from "./captureEye";
import { MixedPilot } from "./mixedPilot";
import { HeadsetPanel, type PanelPage } from "./panel";
import { HeadsetEquipment } from "./equipment";
import {
  landFacing, roomLanding, smoothTurnAngle, smoothTurnDefault, smoothTurnMax, smoothTurnMin,
  teleport, turnAroundHead, viewHeading, WalkElevation,
} from "./navigation";

import { Tabletop } from "./tabletop";
import { FitPlanner } from "./fitPlanner";
import { GuidanceMarker, inspectionLanding } from "./guidance";
import { HeadsetTasks } from "./headsetTasks";
import { HeadsetStepCard } from "./headsetStepCard";
import type { HeadsetLocateTarget, HeadsetStepPin } from "./headsetTasksTypes";
import { WalkWorld } from "./walkWorld";
import { EquipmentPicker, HAND_AIM_MS, stickAxes, stickIntent, TeleportArc } from "./travel";
import { FrameBudget, WalkAppearance } from "./visuals";
import { type FrameArea } from "./frameLog";
import { HandHints } from "./handHints";
import { InputBeams } from "./pointers";
import { ControllerHaptics } from "./haptics";
import { HeadsetNotice } from "./headsetNotice";
import { QuestBackButton, WalkHistory, walkPlace, walkthroughStart, type WalkStop } from "./wayfinding";

interface FrameOptions {
  motion: boolean;
  rates: { supply: number; extract: number };
  fans: string;
}
type Page = "home" | "destinations" | "equipment" | "mixed" | "comfort" | "fitRooms";
type Press = {
  kind:
    | "panel"
    | "equipment"
    | "door"
    | "wrist"
    | "travel"
    | "landing"
    | "wallTrace"
    | "mixed"
    | "tabletop"
    | "fit"
    | "marker"
    | "empty";
  id?: string;
  since: number;
  initialHeading?: number;
  heading?: number;
};

/** A separate tracked camera lets the existing desktop rig retain its target, zoom and projection. */
export class HouseSession {
  readonly rig = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.05, 350);
  private readonly head = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();
  private readonly poseMatrix = new THREE.Matrix4();
  private readonly ray = new THREE.Raycaster();
  private readonly menuGaze = new THREE.Raycaster();
  private readonly lookingAtPanel = (gaze: THREE.Ray) => {
    if (!this.panel.mesh.visible) return false;
    if (this.placeMenu) return true;
    this.menuGaze.ray.copy(gaze).applyMatrix4(this.rig.matrixWorld);
    return !!this.panel.hit(this.menuGaze);
  };
  private readonly panel = new HeadsetPanel();
  private readonly statusCard = new HeadsetNotice();
  private readonly history = new WalkHistory();
  private readonly backButton = new QuestBackButton();
  private readonly ui = new THREE.Group();
  private readonly beams = new InputBeams();
  private readonly haptics = new ControllerHaptics();
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
  private placeId?: string;
  private pendingPlaceId?: string;
  private announceDestination = false;
  private alignedRoom: string | null = null;
  private pausedWork: { room: Room; menuVisible: boolean; label: string; walking: boolean } | null = null;
  private needsFreshPanel = false;
  private presses = new Map<XRInputSource, Press>();
  private stickSource: XRInputSource | null = null;
  private nextSample: XRInputSource | null = null;
  private routeAtPress: string | null | undefined;
  private sticksNeutral = true;
  private walkEnabled = true;
  private walkNeutral = true;
  private smoothTurning = false;
  private turnMode: "smooth" | "snap" = "smooth";
  private turnSpeed = smoothTurnDefault;
  private readonly elevation = new WalkElevation();
  private readonly openedDoors = new Set<string>();
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
  private map: Tabletop | null = null;
  private planner: FitPlanner | null = null;
  private readonly guide = new GuidanceMarker();
  private readonly tasks: HeadsetTasks;
  private readonly pinCard = new HeadsetStepCard();
  private pinned: HeadsetStepPin | null = null;
  private readonly pinSpace = new THREE.Group();
  private readonly identity = new THREE.Matrix4();
  private scene: THREE.Scene;
  private readonly previousBackground: THREE.Scene["background"];
  private firstPose = true;
  private placeMenu = true;
  private queuedCapture = false;
  private queuedMeasurement: RouteMeasurement | undefined;
  private panelClickSource: XRInputSource | null = null;
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
      this.turnMode = localStorage.getItem("vh.xr.turnMode") === "snap" ? "snap" : "smooth";
      const savedSpeed = Number(localStorage.getItem("vh.xr.turnSpeed"));
      if (savedSpeed >= smoothTurnMin && savedSpeed <= smoothTurnMax)
        this.turnSpeed = Math.round(savedSpeed / 5) * 5;
    } catch {
      /* storage is optional */
    }
    this.mixed =
      mode === "vr" ? null : new MixedPilot(runtime, session, space, mode, () => this.suspendAlignment());
    this.scene = this.mixed?.scene ?? runtime.scene!;
    this.tasks = new HeadsetTasks(runtime, {
      locate: (target) => this.locate(target),
      openPinned: (pin) => this.pinStep(pin),
      tell: (message) => this.tell(message),
      exit: () => {
        this.home();
        this.recall();
      },
    });
    this.pinSpace.matrixAutoUpdate = false;
    this.pinSpace.add(this.pinCard.mesh);
    this.scene.add(this.pinSpace, this.guide.group);
    this.previousBackground = this.scene.background;
    if (!this.mixed) this.scene.background = new THREE.Color(0x93a6b2);
    this.destinations = [...runtime.manifest!.rooms.values()].flatMap((room) => {
      const position = roomLanding(room);
      return position ? [{ room, position }] : [];
    });
    this.rig.add(this.camera, this.ui);
    this.ui.add(this.panel.mesh, this.beams.group, this.fade, this.statusCard.mesh);
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
    this.statusCard.hide();
    this.placeMenu = true;
    this.panel.mesh.visible = true;
    this.lastMenu = 0;
  };
  private leaveTools = () => {
    this.home();
    this.recall();
  };
  private home = () => {
    if (this.pausedWork) {
      this.recall();
      return;
    }
    this.map?.dispose();
    this.map = null;
    this.planner?.dispose();
    this.planner = null;
    this.tasks.close();
    this.mixed?.home();
    this.equipment?.dispose();
    this.equipment = null;
    this.page = this.mixed ? "mixed" : "home";
    this.lastMenu = 0;
  };
  private tell(message: string) {
    this.notice = message;
    this.lastMenu = 0;
    if (!this.panel.mesh.visible) this.statusCard.show({ title: message }, this.head, this.orientation);
  }
  private currentRoom() {
    return this.mixed?.room ?? this.runtime.manifest!.rooms.get(this.placeId ?? "");
  }
  private openPlanner(room: Room) {
    this.planner?.dispose();
    this.planner = new FitPlanner(this.runtime, room, this.leaveTools, this.recall);
    this.scene.add(this.planner.group);
    this.recall();
  }
  private openTabletop() {
    if (!this.world) return;
    this.map?.dispose();
    this.map = new Tabletop(
      this.runtime,
      this.world,
      this.worldHead,
      viewHeading(this.rig, this.orientation),
      this.currentRoom()?.floorId,
      (p, yaw, onArrival) => this.go(p, yaw, onArrival),
      this.leaveTools,
    );
    this.scene.add(this.map.group);
    this.recall();
  }
  private locate(target: HeadsetLocateTarget) {
    const room = this.runtime.manifest!.rooms.get(target.roomId ?? "");
    if (this.mixed && (!this.mixed.readyTransform || !room || this.mixed.room?.id !== room.id)) {
      this.tell("Align in " + (target.roomName ?? "the equipment room") + " to see this location.");
      return;
    }
    if (!target.position) {
      const door = room && roomLanding(room);
      if (door && room && !this.mixed) this.travelTo(door, room);
      else this.tell("Only the room is recorded for this item.");
      return;
    }
    if (this.world) {
      const point = new THREE.Vector3(...target.position);
      const view = inspectionLanding(
        this.world,
        point,
        room,
        room?.floorElevation ??
          this.runtime.manifest!.floors.get(target.floorId ?? "")?.elevation ??
          point.y,
        this.head.y,
        target.placementId,
      );
      if (!view) {
        this.tell("No clear viewing spot found near " + target.name);
        return;
      }
      this.blink(view.point, view.heading);
    }
    this.guide.set(target);
    this.panel.hide();
    this.statusCard.show(
      { title: target.name, detail: "Look for the mint ring." },
      this.head,
      this.orientation,
    );
  }
  private pinStep(pin: HeadsetStepPin | null) {
    this.pinned = pin;
    if (!pin) {
      this.pinCard.hide();
      return;
    }
    const m = this.mixed ? this.mixed.readyTransform : this.identity;
    if (!m || (this.mixed && this.mixed.room?.id !== pin.target.roomId)) {
      this.tell("Align in the equipment room to pin this step.");
      return;
    }
    const local = m.clone().invert();
    const h = this.worldHead.clone().applyMatrix4(local);
    const q = this.rig.quaternion
      .clone()
      .multiply(this.orientation)
      .premultiply(new THREE.Quaternion().setFromRotationMatrix(local));
    const at = pin.target.position && new THREE.Vector3(...pin.target.position);
    if (at) {
      const normal = h.clone().sub(at);
      normal.y = 0;
      if (normal.lengthSq() < 0.001) normal.set(0, 0, 1);
      normal.normalize();
      at.addScaledVector(new THREE.Vector3(normal.z, 0, -normal.x), 0.31).addScaledVector(normal, 0.22);
      at.y = Math.max(
        at.y + 0.23,
        (this.runtime.manifest!.rooms.get(pin.target.roomId ?? "")?.floorElevation ?? 0) + 1.04,
      );
      this.pinCard.show(pin, h, q, { position: at, facing: normal });
    } else this.pinCard.show(pin, h, q);
    this.panel.hide();
  }
  private roomEquipment() {
    if (!this.mixed?.showHouseTools || !this.mixed.readyTransform || !this.mixed.room || this.tasks.active)
      return null;
    const roomId = this.mixed.room.id;
    let best = 4,
      found: string | undefined;
    for (const item of this.runtime.store.getState().placements) {
      if (item.roomId !== roomId) continue;
      this.movement.fromArray(item.position).applyMatrix4(this.mixed.readyTransform);
      const distance = this.ray.ray.origin.distanceTo(this.movement);
      if (distance < best && this.ray.ray.distanceSqToPoint(this.movement) < 0.085 ** 2) {
        best = distance;
        found = item.id;
      }
    }
    return found ? { id: found, point: this.ray.ray.at(best, new THREE.Vector3()) } : null;
  }
  private equipmentCard(id: string) {
    const item = this.runtime.store.getState().placements.find((p) => p.id === id);
    if (!item) return;
    this.tasks.close();
    this.equipment?.dispose();
    this.equipment = new HeadsetEquipment(item);
    this.page = "equipment";
    this.notice = "";
    this.recall();
  }
  private capture = () => this.queueCapture();
  private queueCapture = (measurement?: RouteMeasurement) => {
    if (this.uploading || this.queuedCapture) return;
    if (this.retrySave) {
      if (measurement) this.tell("Retry the previous capture before saving another point.");
      else void this.save(this.retrySave);
      return;
    }
    if (measurement && !this.mixed?.canCapturePoint(measurement)) return;
    this.queuedMeasurement = measurement;
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
    if (this.pausedWork && this.mixed) {
      const { room, label } = this.pausedWork;
      if (this.mixed.readyTransform && this.mixed.room && (this.mixed.room.id !== room.id || this.mixed.betweenRooms)) {
        const walking = this.pausedWork.walking;
        return {
          title: "Resume your work",
          lines: [label + " is paused in " + room.name + ".",
            ...(walking ? ["Walk back into that room to resume."] : [])],
          rows: [
            ...(walking ? [] : [{label: "Return to " + room.name, style: "primary" as const, act: () => this.mixed!.enter(room)}]),
            {
              label: this.mixed.betweenRooms ? "Leave paused work" : "Leave paused work and use " + this.mixed.room.name,
              act: () => {
                this.pausedWork = null;
                this.tasks.clearPin();
                this.guide.set(null);
                this.leaveTools();
              },
            },
          ],
        };
      }
      const alignment = this.mixed.menu(options.fans, this.queueCapture);
      alignment.lines.unshift(label + " is paused. Recheck " + room.name + " to resume.");
      return alignment;
    }
    let menu: PanelPage;
    const hapticsRow = {
      id: "controller-haptics",
      label: "Controller vibration · " + this.haptics.level,
      detail: "Cycle standard, light and off",
      act: () => this.haptics.cycle(),
    };
    const toolRows = [
      {
        id: "find",
        label: "Find equipment",
        icon: "find" as const,
        style: "secondary" as const,
        act: () => {
          this.notice = "";
          this.tasks.find(this.currentRoom()?.id);
        },
      },
      {
        id: "fit",
        label: "Fit planner",
        icon: "fit" as const,
        style: "secondary" as const,
        act: () => {
          const room = this.currentRoom();
          if (room) this.openPlanner(room);
          else this.page = "fitRooms";
        },
      },
    ];
    if (this.tasks.active) menu = this.tasks.menu();
    else if (this.planner) menu = this.planner.menu(() => this.panel.hide());
    else if (this.map) menu = this.map.menu();
    else if (this.page === "fitRooms")
      menu = {
        title: "Choose a room to plan",
        lines: [],
        back: this.home,
        rows: this.destinations.map(({ room }) => ({
          id: room.id,
          label: room.name,
          act: () => this.openPlanner(room),
        })),
      };
    else if (this.page === "equipment" && this.equipment) {
      menu = this.equipment.menu();
      menu.rows.unshift(
        {
          id: "maintenance",
          label: "Maintenance and parts",
          style: "primary",
          icon: "service",
          act: () => this.tasks.maintenance(this.equipment!.placement.id),
        },
        { label: "Capture model fix", act: this.capture },
      );
    } else if (this.mixed) {
      menu = this.mixed.menu(options.fans, this.queueCapture);
      if (this.mixed.showHouseTools) menu.rows.push(...toolRows, hapticsRow);
      if (this.mixed.readyTransform) menu.close = () => this.panel.hide();
    } else if (this.page === "destinations")
      menu = {
        title: "Rooms and floors",
        lines: [],
        rows: this.destinations.map(({ room, position }) => ({
          id: room.id,
          label: this.runtime.store.getState().labelPreferences.names[room.id] ?? room.name,
          detail: this.runtime.manifest!.floors.get(room.floorId)?.name,
          act: () => this.travelTo(position, room),
        })),
      };
    else if (this.page === "comfort")
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
          { id: "smooth-turn", label: "Smooth turning", detail: "Hold the right stick", style: "choice",
            active: this.turnMode === "smooth", act: () => this.setTurnMode("smooth") },
          { id: "snap-turn", label: "Snap turning", detail: "30° per flick", style: "choice",
            active: this.turnMode === "snap", act: () => this.setTurnMode("snap") },
          ...(this.turnMode === "smooth" ? [{ id: "smooth-turn-speed", label: `Turn speed · ${this.turnSpeed}°/s`,
            value: (this.turnSpeed - smoothTurnMin) / (smoothTurnMax - smoothTurnMin),
            act: (fraction: number) => this.setTurnSpeed(fraction) }] : []),
          { label: "Turn left 30°", style: "secondary", act: () => this.turn(1) },
          { label: "Turn right 30°", style: "secondary", act: () => this.turn(-1) },
          hapticsRow,
          { label: "Try 90 Hz", act: this.budget.canTry90 ? () => this.budget.try90() : undefined },
        ],
      };
    else {
      const garage = this.destinations.find(
        (d) =>
          d.room.kind === "room" &&
          /garage/i.test(this.runtime.manifest!.buildings.get(d.room.buildingId ?? "")?.name ?? ""),
      );
      const previous = this.history.previous;
      menu = {
        title: "Virtual Home",
        close: () => this.panel.hide(),
        lines: [
          "Point your left controller at the ground. Click the trigger to teleport, or hold it and turn the arrow with the left stick. Release to land.",
        ],
        rows: [
          {
            id: "yard",
            label: "Yard",
            detail: "Outdoor landing",
            style: "travel",
            icon: "yard",
            act: this.world?.yard ? () => this.travelToYard() : undefined,
          },
          {
            id: "garage",
            label: "Garage",
            detail: garage ? this.runtime.manifest!.floors.get(garage.room.floorId)?.name : undefined,
            style: "travel",
            icon: "garage",
            act: garage ? () => this.travelTo(garage.position, garage.room) : undefined,
          },
          {
            id: "tabletop",
            label: "Tabletop map",
            icon: "map",
            style: "primary",
            act: () => this.openTabletop(),
          },
          ...toolRows,
          {
            id: "rooms",
            label: "Rooms and floors",
            style: "primary",
            icon: "rooms",
            act: () => {
              this.page = "destinations";
            },
          },
          {
            id: "comfort",
            label: "Movement and comfort",
            style: "secondary",
            icon: "comfort",
            act: () => {
              this.page = "comfort";
            },
          },
          {
            id: "capture",
            label: "Capture model fix",
            style: "secondary",
            icon: "camera",
            act: this.capture,
          },
          ...(previous
            ? [
                {
                  id: "return",
                  label: "Return to " + previous.place.name,
                  detail: previous.place.floor,
                  act: () => this.returnToPrevious(),
                },
              ]
            : []),
        ],
      };
    }
    if (
      this.guide.target &&
      !this.tasks.active &&
      !this.map &&
      !this.planner &&
      (!this.mixed || this.mixed.showHouseTools)
    )
      menu.rows.push({ label: "Hide location marker", act: () => this.guide.set(null) });
    if (this.pinned && !this.tasks.active)
      menu.rows.push({ label: "Unpin maintenance step", act: () => this.tasks.clearPin() });
    if (
      !this.map &&
      !this.planner &&
      !this.tasks.active &&
      (this.page === "destinations" || this.page === "comfort")
    )
      menu.back = this.home;
    if (this.retrySave) menu.rows.unshift({label: "Retry saving capture", act: this.capture});
    if (this.notice) menu.lines.unshift(this.notice);
    return menu;
  }
  private turn(sign: number) {
    this.move(() => turnAroundHead(this.rig, this.head, (sign * Math.PI) / 6));
  }

  private setTurnMode(mode: HouseSession["turnMode"]) {
    this.turnMode = mode;
    this.smoothTurning = false;
    this.sticksNeutral = false;
    try { localStorage.setItem("vh.xr.turnMode", mode); } catch { /* storage is optional */ }
  }

  private setTurnSpeed(fraction: number) {
    const speed = Math.round((smoothTurnMin + fraction * (smoothTurnMax - smoothTurnMin)) / 5) * 5;
    if (speed === this.turnSpeed) return;
    this.turnSpeed = speed;
    try { localStorage.setItem("vh.xr.turnSpeed", String(speed)); } catch { /* storage is optional */ }
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
  private travelTo(position: Vec3, room: Room) {
    this.go(this.world?.landing(new THREE.Vector3(...position), this.head.y, room));
  }
  private travelToYard() {
    this.go(this.world?.yardLanding(this.head.y), this.world?.yardHeading);
  }
  private takeLandingFeedback() {
    const source = this.panelClickSource;
    this.panelClickSource = null;
    return source ? () => this.haptics.play(source, "land") : undefined;
  }
  private go(dest?: THREE.Vector3 | null, heading?: number, onArrival = this.takeLandingFeedback()) {
    if (!dest) {
      this.notice = "There is no clear standing space at this destination.";
      return;
    }
    this.home();
    this.panel.hide();
    this.blink(dest, heading, true, undefined, onArrival);
  }

  private blink(
    dest: THREE.Vector3,
    heading?: number,
    announce = false,
    returning?: WalkStop,
    onArrival = this.takeLandingFeedback(),
  ) {
    this.move(() => {
      // Scene assets and the wearer's height can change between the preview and the dark frame.
      if (!this.world?.canStand(dest, this.head.y)) {
        if (returning) this.history.returned(returning);
        this.statusCard.show(
          { title: "Landing is blocked", detail: "Choose another spot.", tone: "warning" },
          this.head,
          this.orientation,
        );
        return;
      }
      const feet = this.rig.localToWorld(this.head.clone());
      feet.y = this.elevation.floor;
      if (returning) this.history.returned(returning);
      else if (this.world?.canStand(feet, this.head.y))
        this.history.remember(
          feet,
          viewHeading(this.rig, this.orientation),
          walkPlace(this.runtime, feet, this.destinations),
        );
      if (heading === undefined) teleport(this.rig, this.head, dest);
      else landFacing(this.rig, this.head, this.orientation, dest, heading);
      this.elevation.arrive(dest.y);
      onArrival?.();
      this.locatedAt = 0;
      this.announceDestination = announce;
    });
  }

  private returnToPrevious(onArrival = this.takeLandingFeedback()) {
    const stop = this.history.previous;
    if (!stop || !this.world || this.fadeStart !== null) return;
    if (!this.world.canStand(stop.feet, this.head.y)) {
      this.history.returned(stop);
      this.statusCard.show(
        { title: "Return point is blocked", detail: "Choose another landing.", tone: "warning" },
        this.head,
        this.orientation,
      );
      this.lastMenu = 0;
      return;
    }
    this.home();
    this.panel.hide();
    this.blink(stop.feet, stop.heading, true, stop, onArrival);
  }

  private resetInput = () => {
    this.map?.cancel();
    this.mixed?.cancelWallTrace();
    this.planner?.hover(null);
    this.backButton.reset();
    this.inputHints?.hide();
    this.panel.cancel();
    this.haptics.reset();
    this.presses.clear();
    this.nextSample = null;
    this.routeAtPress = undefined;
    this.stickSource = null;
    this.arc.clear();
    this.sticksNeutral = false;
    this.walkNeutral = false;
    this.smoothTurning = false;
    this.moveAtBlack = null;
    this.fadeStart = null;
    this.fade.visible = false;
    this.budget.resetClock();
  };
  private toggleMenu = (event?: XRInputSourceEvent) => {
    if (this.session.visibilityState !== "visible") return;
    this.resetInput();
    const toMenu = this.movement.subVectors(this.panel.mesh.position, this.head);
    const nearby = toMenu.lengthSq() < 2.25;
    const inView =
      this.forward.set(0, 0, -1).applyQuaternion(this.orientation).dot(toMenu.normalize()) > 0.65;
    if (this.panel.mesh.visible && nearby && inView) this.panel.hide();
    else this.recall();
    if (event?.inputSource) this.haptics.play(event.inputSource, "select");
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
      (this.needsFreshPanel && this.panel.mesh.visible) ||
      this.stickSource ||
      [...this.presses.values()].some(
        (press) =>
          press.kind === "landing" ||
          press.kind === "travel" ||
          press.kind === "tabletop" ||
          press.kind === "fit",
      ) ||
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
    else if (this.mixed?.beginWallTrace(e.frame, source)) press.kind = "wallTrace";
    else if (this.pausedWork && this.mixed) {
      if (!this.mixed.readyTransform) press.kind = "mixed";
    } else if (hasRay && this.map && !this.presses.size) {
      const hit = this.map.hit(this.ray.ray);
      if (hit) {
        press.kind = "tabletop";
        press.id = hit.route?.id;
        this.map.begin(hit, this.head.y, viewHeading(this.rig, this.orientation));
      }
    } else if (hasRay && this.planner?.moving) {
      const point = this.planner.point(this.ray.ray);
      if (point) {
        press.kind = "fit";
        this.planner.hover(point);
      }
    } else if (
      hasRay &&
      this.guide.hit(this.ray.ray) &&
      this.guide.target?.placementId &&
      !this.mixed?.inspectingWall && !this.mixed?.measuringRoute
    ) {
      press.kind = "marker";
      press.id = this.guide.target.placementId;
    } else if (this.map || this.planner) {
      // World clicks belong to the open spatial tool.
    } else if (this.mixed) {
      press.kind = "mixed";
      if (hasRay && !this.mixed.inspectingWall && !this.mixed.measuringRoute) {
        press.id = this.mixed.overlay?.pick(this.ray.ray)?.id;
        if (!press.id) {
          const item = this.roomEquipment();
          if (item) {
            press.kind = "equipment";
            press.id = item.id;
          }
        }
      }
    } else if (hasRay && this.world) {
      const target = this.picker.target(this.world, this.ray, this.runtime.markers);
      if (target?.id) {
        press.kind = "equipment";
        press.id = target.id;
      } else if (target?.doorId) {
        press.kind = "door";
        press.id = target.doorId;
      } else if (!this.panel.mesh.visible && !this.presses.size) {
        if (source.hand && target?.floor) press.kind = "travel";
        else if (
          !source.hand &&
          source.handedness === "left" &&
          (target?.floor || (!target && this.ray.ray.direction.y < -0.06))
        ) {
          press.kind = "landing";
          press.initialHeading = press.heading = viewHeading(this.rig, this.orientation);
          this.arc.aim(this.world, this.ray.ray, this.head.y, press.heading);
          if (this.arc.landing) this.haptics.play(source, "aim");
        }
      }
    }
    this.presses.set(source, press);
  };
  private end = (e: XRInputSourceEvent) => {
    if (this.panel.owns(e.inputSource)) this.panel.cancel();
    const kind = this.presses.get(e.inputSource)?.kind;
    if (kind === "wallTrace") this.mixed?.cancelWallTrace();
    if (kind === "tabletop") this.map?.cancel();
    if (kind === "travel" || kind === "landing") this.arc.clear();
    this.presses.delete(e.inputSource);
  };
  private select = (e: XRInputSourceEvent) => {
    const source = e.inputSource,
      press = this.presses.get(source);
    if (!press || !this.alive || this.session.visibilityState !== "visible") return;
    const hasRay = this.rayFrom(e.frame, source);
    this.lastMenu = 0;
    if (press.kind === "wallTrace") {
      if (this.mixed?.finishWallTrace(e.frame, source)) this.haptics.play(source, "select");
    } else if (press.kind === "panel") {
      this.panelClickSource = source;
      try {
        if (this.panel.end(source, hasRay ? this.panel.hit(this.ray, true) : null) && this.panelClickSource)
          this.haptics.play(source, "select");
      } finally {
        this.panelClickSource = null;
      }
    } else if (press.kind === "wrist") {
      if (hasRay && this.wristHit(source)) this.toggleMenu();
    } else if (hasRay && (this.panel.hit(this.ray) || this.wristHit(source))) {
      if (press.kind === "tabletop") this.map?.cancel();
      // Press began in the world and ended on UI. Neither target owns a click.
    } else if (press.kind === "tabletop" && this.map && hasRay) {
      this.map.orient(this.ray.ray, stickAxes(source.gamepad), viewHeading(this.rig, this.orientation));
      const result = this.map.release(this.map.hit(this.ray.ray), press.id, this.head.y, () =>
        this.haptics.play(source, "land"),
      );
      if (result === "traced") this.haptics.play(source, "select");
    } else if (press.kind === "fit" && this.planner && hasRay) {
      const p = this.planner.point(this.ray.ray);
      if (p) {
        this.planner.commit(p);
        this.haptics.play(source, "select");
      }
    } else if (
      press.kind === "marker" &&
      hasRay &&
      press.id &&
      this.guide.target?.placementId === press.id &&
      this.guide.hit(this.ray.ray)
    ) {
      this.equipmentCard(press.id);
      this.haptics.play(source, "select");
    } else if (press.kind === "landing" && hasRay && this.world) {
      this.aimLeft(source, press);
      const p = this.arc.landing,
        heading = press.heading!;
      if (p) {
        this.blink(p, heading, false, undefined, () => this.haptics.play(source, "land"));
      }
      this.walkNeutral = false;
      this.arc.clear();
    } else if (press.kind === "door" && hasRay && this.world && press.id) {
      if (this.picker.target(this.world, this.ray, this.runtime.markers)?.doorId === press.id) {
        this.world.openDoor(press.id);
        this.haptics.play(source, "select");
      }
    } else if (press.kind === "travel" && hasRay && performance.now() - press.since >= HAND_AIM_MS) {
      const p = this.arc.landing;
      if (p && this.arc.group.visible) this.blink(p, undefined, false, undefined, () => this.haptics.play(source, "land"));
      this.arc.clear();
    } else if (
      press.kind === "equipment" &&
      hasRay &&
      this.mixed &&
      press.id &&
      this.roomEquipment()?.id === press.id &&
      !this.mixed.overlay?.pick(this.ray.ray)
    ) {
      this.equipmentCard(press.id);
      this.haptics.play(source, "select");
    } else if (press.kind === "equipment" && this.world && hasRay) {
      const hit = this.picker.target(this.world, this.ray, this.runtime.markers);
      const item =
        hit?.id === press.id && this.runtime.store.getState().placements.find((p) => p.id === hit?.id);
      if (item) {
        this.equipmentCard(item.id);
        this.haptics.play(source, "select");
      }
    } else if (press.kind === "mixed" && this.mixed) {
      const choosingRoute = this.mode === "mr" && !!this.mixed.readyTransform && !this.mixed.inspectingWall && !this.mixed.measuringRoute;
      if (!choosingRoute || (hasRay && this.mixed.overlay?.pick(this.ray.ray)?.id === press.id)) {
        this.nextSample = source;
        this.routeAtPress = choosingRoute ? (press.id ?? null) : undefined;
      }
    }
    if (press.kind === "tabletop") this.map?.cancel();
    this.presses.delete(source);
  };
  private syncWorld() {
    const index = this.runtime.index;
    if (!index || this.mixed || this.pickables === index.pickables) return;
    this.world?.dispose();
    this.appearance?.dispose();
    this.pickables = index.pickables;
    this.world = new WalkWorld(index, this.openedDoors);
    this.map?.setWalkWorld(this.world);
    this.appearance = new WalkAppearance(index);
    this.appearance.detail(!this.low);
    this.scene.add(this.appearance.sky);
  }
  private aimLeft(source: XRInputSource, press: Press) {
    const axis = stickAxes(source.gamepad);
    if (Math.hypot(axis.x, axis.y) > 0.4)
      press.heading = press.initialHeading! + Math.atan2(-axis.x, -axis.y);
    this.arc.aim(this.world!, this.ray.ray, this.head.y, press.heading);
  }

  private locomotion(frame: XRFrame, sources: XRInputSource[], dt: number) {
    if (this.panel.mesh.visible) {
      let scrollY = 0;
      for (const source of sources) {
        const { y } = stickAxes(source.gamepad);
        if (Math.abs(y) > Math.abs(scrollY) && this.rayFrom(frame, source) && this.panel.hit(this.ray))
          scrollY = y;
      }
      this.panel.scroll(scrollY, dt);
      this.sticksNeutral = this.walkNeutral = false;
      this.smoothTurning = false;
      return;
    }
    if (this.map || this.planner || !this.world) {
      this.sticksNeutral = this.walkNeutral = false;
      this.smoothTurning = false;
      return;
    }
    const right = sources.find((s) => !s.hand && s.handedness === "right");
    const axis = stickAxes(right?.gamepad),
      intent = stickIntent(axis.x, axis.y);
    const neutral = Math.max(Math.abs(axis.x), Math.abs(axis.y)) < 0.32;
    if (this.fadeStart !== null) {
      this.sticksNeutral = neutral;
      this.smoothTurning = false;
      return;
    }
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
          this.blink(p, undefined, false, undefined, () => this.haptics.play(right, "land"));
        }
        this.stickSource = null;
        this.arc.clear();
        this.sticksNeutral = true;
      } else this.arc.aim(this.world, this.ray.ray, this.head.y, viewHeading(this.rig, this.orientation));
      return;
    }
    if (neutral) {
      this.sticksNeutral = true;
      this.smoothTurning = false;
    }
    if (this.presses.size) {
      this.sticksNeutral = neutral;
      this.smoothTurning = false;
      return;
    }
    const angle = this.turnMode === "smooth" && !neutral ? smoothTurnAngle(axis.x, axis.y, dt, this.turnSpeed) : 0;
    if (right && angle && (this.sticksNeutral || this.smoothTurning)) {
      this.sticksNeutral = false;
      this.smoothTurning = this.rayFrom(frame, right);
      if (this.smoothTurning) turnAroundHead(this.rig, this.head, angle);
    } else if (right && this.sticksNeutral && (intent === "aim" || (this.turnMode === "snap" && intent))) {
      this.sticksNeutral = false;
      if (intent === "aim" && this.rayFrom(frame, right)) {
        if (!this.panel.hit(this.ray)) {
          this.stickSource = right;
          this.arc.aim(this.world, this.ray.ray, this.head.y, viewHeading(this.rig, this.orientation));
          if (this.arc.landing) this.haptics.play(right, "aim");
        }
      } else if (intent !== "aim") {
        this.turn(intent === "left" ? 1 : -1);
        this.haptics.play(right, "select");
      }
      return;
    }
    if (!this.walkEnabled) return;
    const left = stickAxes(sources.find((s) => !s.hand && s.handedness === "left")?.gamepad);
    const magnitude = Math.hypot(left.x, left.y);
    if (magnitude < 0.16) {
      this.walkNeutral = true;
      return;
    }
    if (!this.walkNeutral) return;
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation).applyQuaternion(this.rig.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.0001) return;
    this.forward.normalize();
    const speed = (Math.min(1, (magnitude - 0.16) / 0.84) * 1.55 * dt) / magnitude;
    const dx = (this.forward.x * -left.y - this.forward.z * left.x) * speed;
    const dz = (this.forward.z * -left.y + this.forward.x * left.x) * speed;
    const feet = this.movement.copy(this.worldHead);
    feet.y = this.elevation.floor;
    const next =
      this.world.step(feet, dx, dz, this.head.y, this.elevation.rendered) ??
      (dx ? this.world.step(feet, dx, 0, this.head.y, this.elevation.rendered) : null) ??
      this.world.step(feet, 0, dz, this.head.y, this.elevation.rendered);
    if (next) {
      this.elevation.floor = next.y;
      this.rig.position.x += next.x - feet.x;
      this.rig.position.z += next.z - feet.z;
    }
  }

  private followWalkElevation(dt: number) {
    if (this.world) this.rig.position.y = this.elevation.follow(dt);
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
    this.map?.clearHover();
    this.planner?.hover(null);
    if (!this.stickSource) this.arc.clear();
    this.updateWrist(frame, sources);
    const placing = this.planner?.moving
      ? Array.from(this.presses).find(([, p]) => p.kind === "fit")?.[0]
      : undefined;
    const preferred = placing ?? sources.find((s) => s.handedness === "right") ?? sources[0];
    let previewed = false;
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
        if (source) {
          this.haptics.hover(source, null, now);
          if (this.presses.get(source)?.kind === "tabletop") this.map?.cancel();
          this.presses.delete(source);
        }
        continue;
      }
      const pose = frame.getPose(source.targetRaySpace, this.space)!;
      const { line, dot, label } = slot;
      this.poseMatrix
        .fromArray(pose.transform.matrix)
        .decompose(line.position, line.quaternion, line.scale);
      const hit = this.panel.hit(this.ray);
      if (hit) {
        slot.probe.visible = false;
        this.mixed?.hideAimPreview(source);
      }
      this.panel.cursor(i, hit);
      if (this.panel.owns(source)) this.panel.drag(source, this.panel.hit(this.ray, true));
      const press = this.presses.get(source);
      if (press || this.stickSource === source) this.haptics.hover(source, null, now);
      if (press?.kind === "landing" && this.world) {
        if (!hit) this.aimLeft(source, press);
        continue;
      }
      if (press?.kind === "travel" && this.world && now - press.since >= HAND_AIM_MS) {
        if (hit || this.wristHit(source)) this.arc.clear();
        else this.arc.aim(this.world, this.ray.ray, this.head.y, viewHeading(this.rig, this.orientation));
        continue;
      }
      if (this.stickSource === source) continue;
      let point = hit?.point,
        text = "",
        active = !!hit?.row?.act || !!hit?.scrollbar;
      let hoverTarget = hit?.row?.act ? hit.row.key : null;
      if (!hit) {
        const wrist = this.wristHit(source);
        if (wrist) {
          point = wrist.point;
          active = true;
          slot.probe.visible = false;
          this.mixed?.hideAimPreview(source);
        } else if (this.map) {
          if (press?.kind === "tabletop")
            this.map.orient(
              this.ray.ray,
              stickAxes(source.gamepad),
              viewHeading(this.rig, this.orientation),
            );
          const spot = this.map.hit(this.ray.ray);
          point = spot?.point;
          const preview = spot && this.map.preview(i, spot, this.head.y, this.ray.ray, now);
          text = preview === "blocked" ? "Landing blocked" : (spot?.label ?? "");
          active = preview === "valid";
          if (spot?.route) hoverTarget = "route/" + spot.route.id;
        } else if (this.planner && !this.pausedWork) {
          const p = this.planner.point(this.ray.ray);
          if (p) {
            if (source === preferred || (!placing && !previewed)) {
              this.planner.hover(p);
              previewed = true;
            }
            point = p.clone().applyMatrix4(this.planner.group.matrixWorld);
            active = true;
            text = "Place here";
          }
        } else if (!this.mixed?.inspectingWall && !this.mixed?.measuringRoute && this.guide.hit(this.ray.ray)) {
          point = this.guide.hit(this.ray.ray) ?? undefined;
          active = !!this.guide.target?.placementId;
          text = this.guide.target?.name ?? "";
          if (active) hoverTarget = "marker/" + this.guide.target!.placementId;
        } else if (this.world) {
          const target = this.picker.target(this.world, this.ray, this.runtime.markers);
          point = target?.point;
          if (target?.id) {
            slot.highlight.equipment(target.mesh, target.instanceId);
            text = this.hoverNames.get(target.id) ?? "Equipment";
            hoverTarget = "equipment/" + target.id;
            active = true;
          } else if (target?.doorId) {
            slot.highlight.equipment(target.mesh);
            text = "Open door";
            hoverTarget = "door/" + target.doorId;
            active = true;
          } else if (
            !source.hand &&
            source.handedness === "left" &&
            !this.panel.mesh.visible &&
            !this.stickSource &&
            !this.presses.size &&
            this.fadeStart === null &&
            (target?.floor || (!target && this.ray.ray.direction.y < -0.06))
          ) {
            this.haptics.hover(source, null, now);
            this.arc.aim(this.world, this.ray.ray, this.head.y, viewHeading(this.rig, this.orientation));
            continue;
          } else if (source.hand && target?.floor) active = true;
        } else if (this.mixed?.overlay && !this.mixed.inspectingWall && !this.mixed.measuringRoute) {
          const route = this.mixed.overlay.pick(this.ray.ray);
          if (route) {
            point = this.ray.ray.at(route.distance, new THREE.Vector3());
            slot.highlight.route(this.mixed.overlay.group, route.segment, route.approximate);
            text = route.label;
            hoverTarget = "route/" + route.id;
            active = true;
          } else {
            const item = this.roomEquipment();
            if (item) {
              point = item.point;
              active = true;
              text = this.hoverNames.get(item.id) ?? "Equipment";
              hoverTarget = "equipment/" + item.id;
            }
          }
        }
      }
      if (!press && this.fadeStart === null) this.haptics.hover(source, hoverTarget, now);
      line.visible = true;
      if (point) line.scale.z = this.ray.ray.origin.distanceTo(point);
      else if (this.mixed?.aimingAtRoom) {
        line.scale.z = slot.probe.visible ? line.position.distanceTo(slot.probe.position) : 4;
        active = true;
      } else line.scale.z = 0.65;
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
  private suspendAlignment(walking = false) {
    this.planner?.transform(null);
    this.pinSpace.visible = false;
    this.guide.group.visible = false;
    this.queuedCapture = false;
    this.queuedMeasurement = undefined;
    if (!this.alignedRoom) return;
    if (walking && !this.pausedWork && !this.planner && !this.pinned && !this.tasks.active) {
      this.equipment?.dispose();
      this.equipment = null;
      this.guide.set(null);
    }
    const room = this.runtime.manifest?.rooms.get(this.alignedRoom);
    const label = this.planner
      ? "Fit planner"
      : this.pinned
        ? "Pinned step"
        : this.tasks.active
          ? "Your task"
          : this.equipment
            ? "Equipment view"
            : this.guide.target
              ? "Equipment location"
              : null;
    if (room && label && !this.pausedWork) {
      this.pausedWork = { room, label, menuVisible: this.panel.mesh.visible, walking };
    }
    this.alignedRoom = null;
    // A trigger pressed on the old menu must never activate a recovery control or place a draft.
    this.resetInput();
    this.needsFreshPanel = true;
    if (!walking || this.pausedWork) this.recall();
  }

  private updatePlace(now: number) {
    if (this.mixed) {
      this.area = this.mode === "survey" ? "Room survey" : "Mixed reality";
      const room = this.mixed.room;
      const verified = room && this.mixed.readyTransform;
      const walked = !!(verified && this.alignedRoom && room.id !== this.alignedRoom);
      if (verified && (walked || this.mixed.betweenRooms)) this.suspendAlignment(true);
      if (this.mixed.betweenRooms) return;
      if (!verified) {
        this.suspendAlignment();
      } else if (room.id !== this.alignedRoom && this.presses.size === 0) {
        this.resetInput();
        this.needsFreshPanel = true;
        if (this.pausedWork) {
          if (room.id !== this.pausedWork.room.id) {
            // No transform from this room can be used with the previous room's draft.
            this.alignedRoom = room.id;
            this.recall();
            return;
          }
          const { menuVisible, label } = this.pausedWork;
          this.pausedWork = null;
          this.alignedRoom = room.id;
          if (menuVisible) this.recall();
          else {
            this.panel.hide();
            this.statusCard.show(
              { title: label + " resumed", detail: room.name, tone: "success" },
              this.head,
              this.orientation,
              now,
            );
          }
          return;
        }
        this.alignedRoom = room.id;
        if (this.mode === "mr") {
          this.panel.hide();
          const error = this.mixed.calibration?.state.errorM;
          const name = this.runtime.store.getState().labelPreferences.names[room.id] ?? room.name;
          const inAnotherRoom = walked || (this.mixed.checkedRoom && this.mixed.checkedRoom.id !== room.id);
          const detail = [error == null ? "" : `${(100 * error).toFixed(1)} cm`, "Select a route to trace"]
            .filter(Boolean)
            .join(" · ");
          this.statusCard.show(
            { title: inAnotherRoom ? name : name + " aligned",
              detail: inAnotherRoom ? this.runtime.manifest?.floors.get(room.floorId)?.name : detail,
              tone: inAnotherRoom ? "arrival" : "success", durationMs: inAnotherRoom ? 2200 : 4800 },
            this.head,
            this.orientation,
            now,
          );
        }
      }
      return;
    }
    if (!this.world || this.firstPose || (this.locatedAt && now - this.locatedAt < 450)) return;
    const feet = this.movement.copy(this.worldHead);
    feet.y = this.elevation.floor;
    const place = walkPlace(this.runtime, feet, this.destinations);
    this.area = place.area;
    // Do not flash a card for every doorway crossed in passing. Named travel is immediate.
    if (
      this.announceDestination ||
      !this.placeId ||
      (place.id !== this.placeId && this.pendingPlaceId === place.id)
    ) {
      const first = !this.placeId;
      this.placeId = place.id;
      if (!this.panel.mesh.visible) {
        const usingHands = Array.from(this.session.inputSources).some((input) => input.hand);
        const detail = [place.floor, first ? (usingHands ? "Pinch the wrist menu" : "Grip for menu") : ""]
          .filter(Boolean)
          .join(" · ");
        this.statusCard.show(
          { title: place.name, detail, tone: "arrival" },
          this.head,
          this.orientation,
          now,
        );
      }
    }
    this.pendingPlaceId = place.id;
    this.announceDestination = false;
    this.locatedAt = now;
  }

  frame(gl: THREE.WebGLRenderer, frame: XRFrame, delta: number, options: FrameOptions) {
    this.mixed?.frame(frame, delta, options.motion, options.rates, this.lookingAtPanel, this.panel.mesh.visible);
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || this.session.visibilityState !== "visible" || viewer.emulatedPosition) {
      if (this.mixed) this.suspendAlignment();
      this.resetInput();
      this.statusCard.hide();
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
    if (this.firstPose && !this.mixed && this.runtime.store.getState().phase === "loading") {
      gl.clear();
      return;
    }
    if (this.firstPose && this.world && this.pickables?.length) {
      const landing = walkthroughStart(
        this.destinations, this.runtime.store.getState().labelPreferences.names, this.world, this.head.y,
      ) ?? this.world.landingAt(this.head.x, this.head.z, 0, this.head.y)
        ?? this.world.yardLanding(this.head.y);
      if (landing) {
        teleport(this.rig, this.head, landing);
        this.elevation.arrive(landing.y);
      } else {
        this.page = "destinations";
        this.notice = "Choose a room to find a clear starting spot.";
        this.recall();
      }
      this.firstPose = false;
    }
    this.worldHead.copy(this.head).applyMatrix4(this.rig.matrixWorld);
    this.world?.updateDoors(this.worldHead, dt);
    const sources = Array.from(this.session.inputSources).filter(
      (s) => s.targetRayMode === "tracked-pointer",
    );
    if (this.backButton.pressed(sources)) {
      const right = sources.find(source => source.handedness === "right" && !source.hand)!;
      if (this.pausedWork) this.recall();
      else if (this.presses.size || this.stickSource) this.resetInput();
      else if (this.panel.mesh.visible) {
        this.panel.backOrClose();
        this.haptics.play(right, "select");
        this.lastMenu = 0;
      } else if (this.map || this.planner || this.tasks.active) {
        if (this.planner?.moving) this.planner.back();
        else this.recall();
      } else this.returnToPrevious(() => this.haptics.play(right, "land"));
    }
    this.inputHints?.update(frame, this.space, sources);
    this.locomotion(frame, sources, dt);
    this.followWalkElevation(dt);
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
    this.updatePlace(now);
    const modelToWorld = this.pausedWork || this.mixed?.betweenRooms ? null : this.mixed ? this.mixed.readyTransform : this.identity;
    this.planner?.transform(modelToWorld);
    this.guide.update(modelToWorld, this.mixed?.room?.id ?? null, this.worldHead);
    this.pinSpace.visible =
      !!modelToWorld && !!this.pinned && (!this.mixed || this.mixed.room?.id === this.pinned.target.roomId);
    if (modelToWorld && this.pinSpace.visible) {
      this.pinSpace.matrix.copy(modelToWorld);
      this.pinSpace.updateMatrixWorld(true);
    }
    if (this.map) {
      this.movement.copy(this.worldHead).y = this.elevation.floor;
      this.map.userPose(this.movement, viewHeading(this.rig, this.orientation));
    }
    this.appearance?.sky.position.copy(this.worldHead);
    this.appearance?.updateSky(this.scene, now);
    this.statusCard.tick(now);
    this.budget.tick(now, this.area);
    if (this.panel.mesh.visible && (!this.lastMenu || now - this.lastMenu > 200)) {
      this.panel.draw(this.menu(options), this.home, () => {
        void this.session.end();
      });
      this.needsFreshPanel = false;
      this.lastMenu = now;
    }
    if (this.nextSample && this.mixed) {
      const source = this.nextSample;
      const expected = this.routeAtPress;
      this.nextSample = null;
      this.routeAtPress = undefined;
      if (sources.includes(source)) {
        const ray = this.rayFrom(frame, source) ? this.ray.ray : null;
        const overlay = this.mixed.overlay;
        if (expected === undefined) {
          const accepted = this.mixed.select(frame, source, ray);
          if (accepted) this.haptics.play(source, "select");
          if (this.mixed.measuringRoute && !this.panel.mesh.visible) {
            if (this.mixed.measuredRoute) this.recall();
            else this.statusCard.show({
              title: accepted ? "First aim marked" : "Aim at the same spot again",
              detail: "Move your hand sideways about 30 cm.",
            }, this.head, this.orientation, now);
          }
        } else if (ray && overlay?.group.visible && (overlay.pick(ray)?.id ?? null) === expected) {
          const previous = overlay.focusedId;
          this.mixed.select(frame, source, ray);
          if (previous !== overlay.focusedId) {
            this.haptics.play(source, "select");
            const route = this.mixed.selectedRoute;
            this.statusCard.show(
              overlay.focusedId && route
                ? {
                    title: route.name,
                    detail: route.approximate
                      ? "Approximate · Open menu to measure"
                      : "Tracing · Open menu to measure",
                  }
                : { title: "Showing all routes", detail: "Point at one and click to trace it." },
              this.head,
              this.orientation,
              now,
            );
          }
        }
      }
    }
    if (this.panel.mesh.visible) this.panel.tick(dt);
    this.pointers(frame, sources, now);
    if (this.queuedCapture) {
      this.queuedCapture = false;
      const measurement = this.queuedMeasurement;
      this.queuedMeasurement = undefined;
      const view = viewer.views[0];
      if (view && (!measurement || this.mixed?.canCapturePoint(measurement))) this.takeCapture(gl, view, measurement);
    }
    gl.render(this.scene, this.camera);
  }
  private takeCapture(gl: THREE.WebGLRenderer, view: XRView, measurement?: RouteMeasurement) {
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
    const routeId = measurement?.routeId ?? this.mixed?.selectedRoute?.id;
    const selection: Selection | null = routeId
      ? { kind: "route", id: routeId }
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
      this.mixed ? (this.mixed.betweenRooms ? null : this.mixed.room) : this.destinations.find(
        ({ room }) =>
          Math.abs(room.floorElevation - this.elevation.floor) < 0.45 &&
          pointInFootprint(pos.x, pos.z, room.footprint),
      )?.room;
    const snapshot = snapshotModelFixView(this.runtime, this.mode === "vr" ? "vr" : "mr", camera, {
      selection,
      routeMeasurement: measurement,
      overlay: this.mixed?.filter,
      floorId: room?.floorId ?? this.equipment?.placement.floorId,
      roomId: room?.id ?? this.equipment?.placement.roomId,
    });
    const requestId = crypto.randomUUID();
    const arcVisible = this.arc.group.visible;
    this.arc.group.visible = false;
    this.ui.visible = false;
    try {
      // The image and model-space pose are sampled in the same XR animation frame.
      const blob = captureEye(gl, this.scene, eye);
      this.uploading = true;
      void blob
        .then((image) => {
          if (measurement && this.mixed?.measuredRoute === measurement) this.mixed.closeRouteMeasurement();
          return this.save(() => saveModelFix(this.runtime.base, { ...snapshot, images: [image] }, requestId));
        })
        .catch(() => {
          this.notice = "Image encoding failed. Capture again.";
          this.uploading = false;
        });
    } catch {
      this.notice = "Could not capture this frame. Try again.";
    } finally {
      this.ui.visible = true;
      this.arc.group.visible = arcVisible;
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.haptics.reset();
    this.session.removeEventListener("select", this.select);
    this.session.removeEventListener("selectstart", this.start);
    this.session.removeEventListener("selectend", this.end);
    this.session.removeEventListener("squeeze", this.toggleMenu);
    this.session.removeEventListener("inputsourceschange", this.resetInput);
    this.session.removeEventListener("visibilitychange", this.resetInput);
    this.space.removeEventListener?.("reset", this.resetInput);
    this.tasks.dispose();
    this.pinCard.dispose();
    this.pinSpace.removeFromParent();
    this.map?.dispose();
    this.planner?.dispose();
    this.guide.dispose();
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
    this.statusCard.dispose();
    this.fade.geometry.dispose();
    this.fade.material.dispose();
    this.runtime.store.setState({ immersiveMode: null, immersiveLowDetail: false });
    this.runtime.setControlsEnabled(this.savedControls);
    this.runtime.invalidate();
  }
}
