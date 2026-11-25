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
import { pickWalkthrough, roomLanding, teleport, turnAroundHead } from "./navigation";

interface FrameOptions { motion: boolean; rates: {supply: number; extract: number}; fans: string }
type Page = "home" | "destinations" | "equipment" | "mixed";

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
  private readonly reticleGeometry = new THREE.SphereGeometry(0.009, 10, 8);
  private readonly probeMaterial = new THREE.MeshBasicMaterial({ color: 0xffae36, depthTest: false });
  private readonly probes = [new THREE.Mesh(this.reticleGeometry, this.probeMaterial), new THREE.Mesh(this.reticleGeometry, this.probeMaterial)];
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0x90e3df, transparent: true, opacity: 0.72, depthTest: false });
  private readonly lineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-1)]);
  private readonly pointers = [new THREE.Line(this.lineGeometry, this.lineMaterial), new THREE.Line(this.lineGeometry, this.lineMaterial)];
  private readonly fade = new THREE.Mesh(new THREE.SphereGeometry(0.29, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false }));
  private fadeStart: number | null = null;
  private moveAtBlack: (() => void) | null = null;
  private readonly mixed: MixedPilot | null;
  private equipment: HeadsetEquipment | null = null;
  private scene: THREE.Scene;
  private readonly previousBackground: THREE.Scene["background"];
  private firstPose = true;
  private placeMenu = true;
  private wantTeleport = false;
  private snapArmed = true;
  private queuedCapture = false;
  private uploading = false;
  private retrySave: (() => Promise<unknown>) | null = null;
  private notice = "";
  private page: Page;
  private alive = true;
  private lastMenu = 0;
  private readonly destinations: Array<{ room: Room; position: Vec3 }>;
  private savedControls: boolean;

  constructor(private runtime: HouseRuntime, readonly session: XRSession, readonly mode: ImmersiveMode,
    private space: XRReferenceSpace) {
    this.page = mode === "mr" ? "mixed" : "home";
    this.mixed = mode === "mr" ? new MixedPilot(runtime, session, space) : null;
    this.scene = this.mixed?.scene ?? runtime.scene!;
    this.previousBackground = this.scene.background;
    if (!this.mixed) this.scene.background = new THREE.Color(0x93a6b2);
    this.destinations = [...runtime.manifest!.rooms.values()].flatMap(room => {
      const position = roomLanding(room);
      return position ? [{ room, position }] : [];
    });
    this.rig.add(this.camera, this.ui);
    this.ui.add(this.panel.mesh, ...this.pointers, ...this.probes, this.fade);
    this.fade.renderOrder = 10000; this.fade.visible = false;
    this.pointers.forEach(o => { o.visible = false; o.renderOrder = 1000; });
    this.probes.forEach(o => { o.visible = false; o.renderOrder = 1001; });
    this.scene.add(this.rig);
    this.savedControls = runtime.controls?.enabled ?? true;
    runtime.setControlsEnabled(false);
    runtime.store.setState({ immersiveMode: mode });
    session.addEventListener("select", this.select);
    session.addEventListener("squeeze", this.recall);
  }

  private recall = () => { this.placeMenu = true; this.panel.mesh.visible = true; this.lastMenu = 0; };
  private home = () => {
    this.equipment?.dispose(); this.equipment = null;
    this.page = this.mixed ? "mixed" : "home"; this.wantTeleport = false; this.lastMenu = 0;
  };
  private capture = () => {
    if (this.uploading || this.queuedCapture) return;
    if (this.retrySave) { void this.save(this.retrySave); return; }
    this.queuedCapture = true;
  };
  private async save(upload: () => Promise<unknown>) {
    this.uploading = true; this.notice = "Saving capture…";
    try { await upload(); this.retrySave = null; this.notice = "Capture saved to pending model fixes."; }
    catch (error) {
      this.retrySave = upload;
      this.notice = `${error instanceof Error ? error.message : "Capture upload failed"}. Select Capture to retry.`;
    } finally { this.uploading = false; this.lastMenu = 0; }
  }
  private menu(options: FrameOptions): PanelPage {
    let menu: PanelPage;
    if (this.mixed) menu = this.mixed.menu(options.fans, this.capture);
    else if (this.page === "destinations") menu = { title: "Teleport to a room", lines: ["Point and press the trigger to travel."],
      rows: this.destinations.map(({room, position}) => ({
        label: `${this.runtime.store.getState().labelPreferences.names[room.id] ?? room.name} · ${this.runtime.manifest!.floors.get(room.floorId)?.name ?? ""}`,
        act: () => { this.home(); this.move(() => teleport(this.rig, this.head, new THREE.Vector3(...position))); },
      })) };
    else if (this.page === "equipment" && this.equipment) {
      menu = this.equipment.menu(); menu.rows.unshift({ label: "Capture model fix", act: this.capture });
    } else menu = { title: "Virtual Home", lines: [this.wantTeleport ? "Point at a floor or the plot and press the trigger." :
      "Point and trigger to inspect equipment. Right stick turns 30°. Squeeze the grip to recall the menu."],
      rows: [{ label: this.wantTeleport ? "Cancel aimed teleport" : "Aim to teleport", act: () => { this.wantTeleport = !this.wantTeleport; this.notice = ""; } },
        { label: "Rooms and floors", act: () => { this.page = "destinations"; } },
        { label: "Turn left 30°", act: () => this.turn(1) }, { label: "Turn right 30°", act: () => this.turn(-1) },
        { label: "Capture model fix", act: this.capture }, { label: "Hide menu · squeeze grip to recall", act: () => { this.panel.mesh.visible = false; } }] };
    if (this.notice) menu.lines.unshift(this.notice);
    return menu;
  }
  private turn(sign: number) { this.move(() => turnAroundHead(this.rig, this.head, sign * Math.PI / 6)); }
  private move(action: () => void) {
    if (this.fadeStart !== null) return;
    this.fadeStart = performance.now(); this.moveAtBlack = action; this.fade.visible = true;
  }
  private rayFrom(frame: XRFrame, source: XRInputSource) {
    const pose = frame.getPose(source.targetRaySpace, this.space);
    if (!pose) return false;
    this.poseMatrix.fromArray(pose.transform.matrix).premultiply(this.rig.matrixWorld);
    this.ray.ray.origin.setFromMatrixPosition(this.poseMatrix);
    this.ray.ray.direction.set(0, 0, -1).transformDirection(this.poseMatrix);
    return true;
  }
  private select = (event: XRInputSourceEvent) => {
    if (!this.alive || this.session.visibilityState !== "visible" || !this.rayFrom(event.frame, event.inputSource)) return;
    this.lastMenu = 0;
    if (this.panel.press(this.ray)) return;
    this.notice = "";
    if (this.mixed) { this.mixed.select(event.frame, event.inputSource, this.ray.ray); return; }
    const hit = this.runtime.index && pickWalkthrough(this.ray, this.runtime.index, this.runtime.markers);
    if (this.wantTeleport) {
      if (hit?.landing) {
        this.wantTeleport = false;
        this.move(() => teleport(this.rig, this.head, hit.landing!));
      } else this.notice = "Aim at a visible floor or outdoor ground.";
      return;
    }
    const item = this.runtime.store.getState().placements.find(p => p.id === hit?.placementId);
    if (item) {
      this.equipment?.dispose(); this.equipment = new HeadsetEquipment(item);
      this.page = "equipment"; this.recall();
    }
  };

  frame(gl: THREE.WebGLRenderer, frame: XRFrame, delta: number, options: FrameOptions) {
    this.mixed?.frame(frame, delta, options.motion, options.rates);
    const viewer = frame.getViewerPose(this.space);
    if (!viewer) {
      // Remove the last virtual pixels if the browser still supplies a drawable frame.
      if (this.mixed) gl.clear();
      return;
    }
    const {position, orientation} = viewer.transform;
    this.head.set(position.x, position.y, position.z);
    this.orientation.set(orientation.x, orientation.y, orientation.z, orientation.w);
    if (this.firstPose && !this.mixed) {
      const start = this.destinations.find(d => d.room.kind === "room") ?? this.destinations[0];
      if (start) teleport(this.rig, this.head, new THREE.Vector3(...start.position));
    }
    this.firstPose = false;
    if (this.placeMenu) { this.panel.place(this.head, this.orientation); this.placeMenu = false; }
    const now = performance.now();
    if (this.fadeStart !== null) {
      const age = now - this.fadeStart;
      if (age >= 90 && this.moveAtBlack) { this.moveAtBlack(); this.moveAtBlack = null; }
      this.fade.material.opacity = Math.max(0, Math.min(1, age / 90, (230 - age) / 110));
      this.fade.position.copy(this.head);
      if (age >= 230) { this.fadeStart = null; this.fade.visible = false; }
    }
    this.rig.updateMatrixWorld(true);
    const sources = Array.from(this.session.inputSources).filter(input => input.targetRayMode === "tracked-pointer");
    for (let i = 0; i < this.pointers.length; i++) {
      const source = sources[i], pointer = this.pointers[i]!, probe = this.probes[i]!;
      const pose = source && frame.getPose(source.targetRaySpace, this.space);
      pointer.visible = !!pose; probe.visible = false;
      if (!source || !pose) continue;
      this.poseMatrix.fromArray(pose.transform.matrix).decompose(pointer.position, pointer.quaternion, pointer.scale);
      let length = 1.4;
      if (this.wantTeleport && this.runtime.index && this.rayFrom(frame, source)) {
        const hit = pickWalkthrough(this.ray, this.runtime.index, this.runtime.markers);
        if (hit?.point) {
          length = Math.min(40, hit.point.distanceTo(this.ray.ray.origin));
          if (hit.landing) { probe.position.copy(this.rig.worldToLocal(hit.landing.clone())); probe.visible = true; }
        }
      }
      pointer.scale.z = length;
      if (this.mixed?.calibration) probe.visible = !!this.mixed.calibration.pointerPosition(frame, source.gripSpace, probe.position);
    }
    const pad = sources.find(s => s.handedness === "right")?.gamepad;
    if (!this.mixed && pad && this.session.visibilityState === "visible") {
      const axis = pad.axes[2] ?? pad.axes[0] ?? 0;
      if (Math.abs(axis) < 0.35) this.snapArmed = true;
      if (Math.abs(axis) > 0.75 && this.snapArmed) { this.snapArmed = false; this.turn(-Math.sign(axis)); }
    }
    if (!this.lastMenu || now - this.lastMenu > 300) {
      this.panel.draw(this.menu(options), this.home, () => { void this.session.end(); });
      this.lastMenu = now;
    }
    if (this.queuedCapture) {
      this.queuedCapture = false;
      const view = viewer.views[0];
      if (view) this.takeCapture(gl, view);
    }
    gl.render(this.scene, this.camera);
  }

  private takeCapture(gl: THREE.WebGLRenderer, view: XRView) {
    if (this.mixed && !this.mixed.overlay?.group.visible) { this.notice = "Verify alignment before capturing the overlay."; return; }
    const eye = new THREE.PerspectiveCamera();
    eye.projectionMatrix.fromArray(view.projectionMatrix);
    eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    const pose = new THREE.Matrix4().fromArray(view.transform.matrix).premultiply(this.rig.matrixWorld);
    pose.decompose(eye.position, eye.quaternion, eye.scale);
    eye.updateMatrixWorld();
    const selection: Selection | null = this.mixed?.selectedRoute ? { kind: "route", id: this.mixed.selectedRoute.id } :
      this.equipment ? { kind: "equipment", id: this.equipment.placement.id } : null;
    if (this.mixed?.overlay) pose.premultiply(this.mixed.overlay.group.matrix.clone().invert());
    const pos = new THREE.Vector3().setFromMatrixPosition(pose);
    const quat = new THREE.Quaternion().setFromRotationMatrix(pose);
    const camera = { position: pos.toArray(), target: new THREE.Vector3(0,0,-1).applyQuaternion(quat).add(pos).toArray(),
      projection: "perspective" as const, quaternion: quat.toArray() };
    const room = this.mixed?.room ?? this.destinations.find(({room}) =>
      Math.abs(room.floorElevation - this.rig.position.y) < 0.45 && pointInFootprint(pos.x, pos.z, room.footprint))?.room;
    const snapshot = snapshotModelFixView(this.runtime, this.mode, camera, { selection, overlay: this.mixed?.filter,
      floorId: room?.floorId ?? this.equipment?.placement.floorId, roomId: room?.id ?? this.equipment?.placement.roomId });
    const requestId = crypto.randomUUID();
    this.ui.visible = false;
    try {
      // The image and model-space pose are sampled in the same XR animation frame.
      const blob = captureEye(gl, this.scene, eye);
      this.uploading = true;
      void blob.then(image => this.save(() => saveModelFix(this.runtime.base, { ...snapshot, images: [image] }, requestId)))
        .catch(() => { this.notice = "Image encoding failed. Capture again."; this.uploading = false; });
    } catch { this.notice = "Could not capture this frame. Try again."; }
    finally { this.ui.visible = true; }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.session.removeEventListener("select", this.select);
    this.session.removeEventListener("squeeze", this.recall);
    this.equipment?.dispose(); this.mixed?.dispose(); this.rig.removeFromParent();
    this.scene.background = this.previousBackground;
    this.panel.dispose(); this.lineMaterial.dispose(); this.lineGeometry.dispose();
    this.probeMaterial.dispose(); this.reticleGeometry.dispose(); this.fade.geometry.dispose(); this.fade.material.dispose();
    this.runtime.store.setState({ immersiveMode: null });
    this.runtime.setControlsEnabled(this.savedControls);
    this.runtime.invalidate();
  }
}
