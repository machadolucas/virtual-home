import * as THREE from "three";
import {
  PANEL_WIDTH, contains, layoutPanel, paintPanel, panelFont, scrollThumb, sliderRange, visibleRow,
  type PanelButton, type PanelLayout, type PanelPage, type PanelRect,
} from "./panelLayout";

export type { PanelPage, PanelRow } from "./panelLayout";

export interface PanelHit {
  point: THREE.Vector3;
  x: number;
  y: number;
  row?: PanelButton;
  scrollbar?: boolean;
}

const WIDTH_M = 0.61;
const CLICK_SLOP = 13;
const DRAG_THRESHOLD = 16;
const MAX_VELOCITY = 2_800;

function highlight(color: number, opacity: number) {
  const mark = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  mark.renderOrder = 1000;
  mark.visible = false;
  return mark;
}

function backingShape() {
  const shape = new THREE.Shape();
  const edge = .5, corner = .025;
  shape.moveTo(-edge + corner, -edge);
  shape.lineTo(edge - corner, -edge);
  shape.quadraticCurveTo(edge, -edge, edge, -edge + corner);
  shape.lineTo(edge, edge - corner);
  shape.quadraticCurveTo(edge, edge, edge - corner, edge);
  shape.lineTo(-edge + corner, edge);
  shape.quadraticCurveTo(-edge, edge, -edge, edge - corner);
  shape.lineTo(-edge, -edge + corner);
  shape.quadraticCurveTo(-edge, -edge, -edge + corner, -edge);
  return new THREE.ShapeGeometry(shape, 10);
}

interface Hold {
  source: XRInputSource;
  kind: "press" | "slider" | "scroll" | "thumb";
  key?: string;
  x: number;
  y: number;
  offset: number;
  position: number;
  time: number;
  thumbGrab: number;
}

function roundedContains(rect: PanelRect, x: number, y: number, radius: number) {
  if (!contains(rect, x, y)) return false;
  const dx = x - THREE.MathUtils.clamp(x, rect.x + radius, rect.x + rect.width - radius);
  const dy = y - THREE.MathUtils.clamp(y, rect.y + radius, rect.y + rect.height - radius);
  return dx * dx + dy * dy <= radius * radius;
}

/** The headset texture and ray-hit coordinates share one clipped, continuously scrolling layout. */
export class HeadsetPanel {
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private backing = new THREE.Mesh(backingShape(), new THREE.MeshBasicMaterial({
    color: 0x0a121a, depthTest: false, depthWrite: false, toneMapped: false,
  }));
  private hover = [highlight(0x7de3cf, .19), highlight(0x7de3cf, .19)];
  private pressed = highlight(0x86e6d3, .35);
  private hoverPoint: Array<Pick<PanelHit, "x" | "y"> | null> = [null, null];
  private layout: PanelLayout | null = null;
  private paintKey = "";
  private title = "";
  private offset = 0;
  private velocity = 0;
  private lastMovedAt = 0;
  private dirty = false;
  private held: Hold | null = null;
  private rangePlane = new THREE.Plane();
  private planeNormal = new THREE.Vector3();
  private planePoint = new THREE.Vector3();

  constructor() {
    this.canvas.width = PANEL_WIDTH;
    this.canvas.height = 510;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("The headset menu could not be created.");
    this.context = ctx;
    this.texture = this.makeTexture();
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      }),
    );
    this.mesh.name = "vh-headset-menu";
    this.backing.scale.set(1.014, 1.015, 1);
    this.backing.position.set(.004, -.009, -.012);
    this.backing.renderOrder = 998;
    this.mesh.add(this.backing, ...this.hover, this.pressed);
    this.mesh.renderOrder = 999;
    this.mesh.scale.set(WIDTH_M, WIDTH_M * this.canvas.height / PANEL_WIDTH, 1);
  }

  private makeTexture() {
    const texture = new THREE.CanvasTexture(this.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  }

  place(head: THREE.Vector3, orientation: THREE.Quaternion) {
    const forward = this.planeNormal.set(0, 0, -1).applyQuaternion(orientation);
    this.mesh.rotation.set(0, Math.atan2(-forward.x, -forward.z) + 0.11, 0);
    this.mesh.position.set(0, -0.1, -0.91).applyQuaternion(this.mesh.quaternion).add(head);
    this.mesh.updateWorldMatrix(true, true);
  }

  draw(menu: PanelPage, home: () => void, exit: () => void) {
    if (menu.title !== this.title) {
      this.title = menu.title;
      this.cancel();
      this.offset = 0;
    }
    const c = this.context;
    panelFont(c);
    const layout = layoutPanel(menu, (value) => c.measureText(value).width, home, exit);
    this.layout = layout;
    this.setOffset(this.offset);
    const key = JSON.stringify([
      layout.title, layout.lines, menu.corners,
      ...[...layout.rows, ...layout.footer].map((row) => [
        row.key, row.label, row.value, row.active, row.detail, row.style, row.icon, !!row.act,
      ]),
    ]);
    if (key !== this.paintKey) {
      this.paintKey = key;
      this.dirty = true;
    }
    if (this.canvas.height !== layout.height) {
      this.canvas.height = layout.height;
      // A newly sized canvas needs a new immutable GPU texture allocation.
      this.texture.dispose();
      this.texture = this.makeTexture();
      this.mesh.material.map = this.texture;
      this.mesh.scale.y = WIDTH_M * layout.height / PANEL_WIDTH;
      this.mesh.updateWorldMatrix(true, true);
      this.dirty = true;
    }
    this.renderPanel();
    this.updateHighlights();
  }

  get canScroll() {
    return this.mesh.visible && (this.layout?.maxScroll ?? 0) > 0;
  }

  /** Positive Y moves forward through the list. The session arbitrates locomotion first. */
  scroll(axisY: number, dt: number) {
    if (!this.canScroll || this.held || Math.abs(axisY) < .18 || !Number.isFinite(axisY) || !Number.isFinite(dt)) return false;
    const magnitude = (Math.min(1, Math.abs(axisY)) - .18) / .82;
    this.velocity = 0;
    this.setOffset(this.offset + Math.sign(axisY) * magnitude ** 1.5 * 760 * THREE.MathUtils.clamp(dt, 0, .05));
    return true;
  }

  /** Inertia is active only after releasing a content drag. Paint at most once per frame. */
  tick(dt: number) {
    if (!this.mesh.visible) {
      if (this.held || this.velocity || this.hoverPoint.some(Boolean)) this.cancel();
      return;
    }
    if (!this.held && this.velocity && Number.isFinite(dt) && dt > 0) {
      const elapsed = Math.min(dt, .05);
      this.setOffset(this.offset + this.velocity * elapsed);
      this.velocity *= Math.exp(-8.5 * elapsed);
      if (Math.abs(this.velocity) < 14 || this.offset <= 0 || this.offset >= (this.layout?.maxScroll ?? 0)) this.velocity = 0;
    }
    this.renderPanel();
    this.updateHighlights();
  }

  private setOffset(value: number) {
    const clamped = THREE.MathUtils.clamp(value, 0, this.layout?.maxScroll ?? 0);
    const position = Math.round(clamped * 4) / 4;
    if (position !== this.offset) {
      this.offset = position;
      this.dirty = true;
    }
  }

  private renderPanel() {
    if (!this.layout || !this.dirty) return;
    this.dirty = false;
    paintPanel(this.context, this.layout, this.offset, this.held?.kind === "thumb");
    this.texture.needsUpdate = true;
  }

  private rowAt(x: number, y: number) {
    const layout = this.layout;
    if (!layout) return undefined;
    const footer = layout.footer.find((row) => roundedContains(row, x, y, 13));
    if (footer || !contains(layout.body, x, y)) return footer;
    const row = layout.rows.find((item) => roundedContains(item, x, y + this.offset, 14));
    return row ? visibleRow(layout, row, this.offset) : undefined;
  }

  hit(ray: THREE.Raycaster, extended = false): PanelHit | null {
    if (!this.mesh.visible || !this.layout) return null;
    this.mesh.updateWorldMatrix(true, false);
    this.planeNormal.set(0, 0, 1).transformDirection(this.mesh.matrixWorld);
    if (ray.ray.direction.dot(this.planeNormal) >= -.005) return null;
    this.rangePlane.setFromNormalAndCoplanarPoint(this.planeNormal, this.planePoint.setFromMatrixPosition(this.mesh.matrixWorld));
    const point = ray.ray.intersectPlane(this.rangePlane, new THREE.Vector3());
    if (!point || point.distanceTo(ray.ray.origin) > 4) return null;
    const local = this.mesh.worldToLocal(point.clone());
    const x = (local.x + .5) * PANEL_WIDTH, y = (.5 - local.y) * this.layout.height;
    if (!extended && !roundedContains({ x: 1, y: 1, width: PANEL_WIDTH - 2, height: this.layout.height - 2 }, x, y, 26)) return null;
    return { point, x, y, row: this.rowAt(x, y), scrollbar: this.canScroll && contains(this.layout.track, x, y) };
  }

  private mark(mesh: ReturnType<typeof highlight>, rect?: PanelRect) {
    mesh.visible = !!rect && rect.height > 4;
    if (!rect || !this.layout) return;
    const height = this.layout.height;
    mesh.position.set((rect.x + rect.width / 2) / PANEL_WIDTH - .5, .5 - (rect.y + rect.height / 2) / height, .001);
    mesh.scale.set((rect.width - 6) / PANEL_WIDTH, Math.max(0, rect.height - 4) / height, 1);
  }

  private visible(key: string | undefined) {
    if (!key || !this.layout) return undefined;
    const row = this.layout.rows.find((button) => button.key === key) ?? this.layout.footer.find((button) => button.key === key);
    return row ? visibleRow(this.layout, row, this.offset) : undefined;
  }

  private updateHighlights() {
    for (const [i, mark] of this.hover.entries()) {
      const p = this.hoverPoint[i];
      const row = p ? this.rowAt(p.x, p.y) : undefined;
      const layout = this.layout;
      const thumb = p && this.canScroll && layout ? scrollThumb(layout, this.offset) : undefined;
      this.mark(mark, row?.act ? row : thumb && p && contains(thumb, p.x, p.y) ? thumb : undefined);
    }
    const hold = this.held;
    const pressed = hold?.kind === "press" || hold?.kind === "slider" ? this.visible(hold.key) : undefined;
    this.mark(this.pressed, pressed?.act ? pressed : undefined);
  }

  cursor(index: number, hit: PanelHit | null) {
    if (index < 0 || index >= this.hoverPoint.length) return;
    this.hoverPoint[index] = hit;
    this.updateHighlights();
  }

  start(source: XRInputSource, hit: PanelHit) {
    if (!this.mesh.visible || this.held || !this.layout) return;
    const { x, y } = hit;
    const row = this.rowAt(x, y);
    const layout = this.layout;
    const scrollbar = this.canScroll && contains(layout.track, x, y);
    const body = this.canScroll && contains(layout.body, x, y);
    if (!row?.act && !scrollbar && !body) return;
    this.velocity = 0;
    this.held = {
      source, kind: scrollbar ? "thumb" : row?.act && row.value !== undefined ? "slider" : "press",
      x, y, key: row?.act ? row.key : undefined,
      offset: this.offset, position: this.offset, time: performance.now(), thumbGrab: 0,
    };
    if (scrollbar) {
      const thumb = scrollThumb(layout, this.offset);
      this.held.thumbGrab = contains(thumb, x, y) ? y - thumb.y : thumb.height / 2;
      this.dragThumb(y, this.held.thumbGrab);
      this.dirty = true;
    } else if (row?.act && this.held.kind === "slider") {
      row.act(this.fraction(row, x));
    }
    this.updateHighlights();
  }

  owns(source: XRInputSource) {
    return this.held?.source === source;
  }

  private fraction(row: PanelButton, x: number) {
    const [left, right] = sliderRange(row);
    return THREE.MathUtils.clamp((x - left) / (right - left), 0, 1);
  }

  private dragThumb(y: number, grab: number) {
    if (!this.layout) return;
    const track = this.layout.track;
    const thumb = scrollThumb(this.layout, this.offset);
    const travel = Math.max(1, track.height - thumb.height);
    this.setOffset((y - track.y - grab) / travel * this.layout.maxScroll);
  }

  drag(source: XRInputSource, hit: PanelHit | null) {
    const hold = this.held;
    if (!hold || hold.source !== source || !this.layout) return;
    if (!hit) {
      this.cancel();
      return;
    }
    if (hold.kind === "thumb") this.dragThumb(hit.y, hold.thumbGrab);
    else if (hold.kind === "slider") {
      const row = this.visible(hold.key);
      if (!row?.act) this.cancel();
      else row.act(this.fraction(row, hit.x));
    } else {
      const vertical = hit.y - hold.y;
      const horizontal = Math.abs(hit.x - hold.x);
      const canDrag = this.canScroll && contains(this.layout.body, hold.x, hold.y);
      if (hold.kind === "press" && canDrag && Math.abs(vertical) >= DRAG_THRESHOLD && Math.abs(vertical) > horizontal * .55)
        hold.kind = "scroll";
      if (hold.kind === "scroll") {
        this.setOffset(hold.offset - vertical);
        if (this.offset !== hold.position) {
          const now = performance.now();
          const elapsed = THREE.MathUtils.clamp((now - hold.time) / 1_000, .008, .05);
          const speed = THREE.MathUtils.clamp((this.offset - hold.position) / elapsed, -MAX_VELOCITY, MAX_VELOCITY);
          this.velocity = this.velocity * .35 + speed * .65;
          hold.position = this.offset;
          hold.time = this.lastMovedAt = now;
        }
      } else if (hold.key) {
        const row = this.visible(hold.key);
        if (!row || !contains(row, hit.x, hit.y, CLICK_SLOP)) this.cancel();
      }
    }
    this.updateHighlights();
  }

  end(source: XRInputSource, hit: PanelHit | null) {
    if (!this.owns(source)) return false;
    this.drag(source, hit);
    const hold = this.held;
    if (!hold || !hit) return false;
    const row = this.visible(hold.key);
    this.held = null;
    if (hold.kind === "thumb") this.dirty = true;
    if (hold.kind !== "scroll" || performance.now() - this.lastMovedAt > 90) this.velocity = 0;
    this.updateHighlights();
    if (hold.kind !== "press" || !row?.act) return hold.kind === "slider" && !!row?.act;
    row.act(this.fraction(row, hit.x));
    return true;
  }

  cancel() {
    if (this.held?.kind === "thumb") this.dirty = true;
    this.held = null;
    this.velocity = 0;
    this.hoverPoint.fill(null);
    for (const mark of [...this.hover, this.pressed]) mark.visible = false;
  }

  hide() {
    this.mesh.visible = false;
    this.cancel();
  }

  backOrClose() {
    const back = this.layout?.footer.find(row => row.kind === "back")?.act;
    if (back) { this.cancel(); back(0); }
    else this.hide();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    for (const part of [this.backing, ...this.hover, this.pressed]) {
      part.geometry.dispose();
      part.material.dispose();
    }
  }
}
