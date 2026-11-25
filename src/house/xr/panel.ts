import * as THREE from "three";

export interface PanelRow {
  label: string;
  act?: (fraction: number) => void;
  value?: number;
  id?: string;
}
export interface PanelPage {
  title: string;
  lines: string[];
  rows: PanelRow[];
  corners?: readonly (readonly number[])[];
}
interface Button extends PanelRow {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PanelHit {
  point: THREE.Vector3;
  x: number;
  y: number;
  row?: Button;
}
const WIDTH = 768,
  MAX_HEIGHT = 1024,
  PER_PAGE = 6;
const padding = 20,
  gap = 8,
  buttonHeight = 70;

function rounded(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (typeof context.roundRect !== "function") {
    context.fillRect(x, y, w, h);
    return;
  }
  context.beginPath();
  context.roundRect(x, y, w, h, r);
  context.fill();
}

function highlight(color: number) {
  const mark = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mark.renderOrder = 1000;
  mark.visible = false;
  return mark;
}

/** Text is uploaded only on content changes. Pointer/press feedback moves cheap overlay quads. */
export class HeadsetPanel {
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private hover = [highlight(0x7bdfcd), highlight(0x7bdfcd)];
  private pressed = highlight(0xffbc65);
  private rows: Button[] = [];
  private last = "";
  private page = 0;
  private title = "";
  private held: { source: XRInputSource; key: string; slider: boolean; cancelled: boolean } | null = null;
  private rangePlane = new THREE.Plane();
  private planeNormal = new THREE.Vector3();
  private planePoint = new THREE.Vector3();
  constructor() {
    this.canvas.width = WIDTH;
    this.canvas.height = MAX_HEIGHT;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("The headset menu could not be created.");
    this.context = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.mesh.add(...this.hover, this.pressed);
    this.mesh.renderOrder = 999;
    this.mesh.scale.set(0.52, 0.69, 1);
  }
  place(head: THREE.Vector3, orientation: THREE.Quaternion) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    this.mesh.rotation.set(0, Math.atan2(-forward.x, -forward.z) + 0.16, 0);
    this.mesh.position.set(0, -0.1, -0.85).applyQuaternion(this.mesh.quaternion).add(head);
    this.mesh.updateWorldMatrix(true, true);
  }
  draw(menu: PanelPage, home: () => void, exit: () => void) {
    if (menu.title !== this.title) {
      this.page = 0;
      this.title = menu.title;
      this.cancel();
    }
    const pages = Math.max(1, Math.ceil(menu.rows.length / PER_PAGE));
    this.page = Math.min(this.page, pages - 1);
    const slice = menu.rows.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE);
    const c = this.context;
    c.font = "27px sans-serif";
    const lines: string[] = [];
    for (const line of menu.lines) {
      let part = "";
      for (const word of line.split(" ")) {
        const next = part ? part + " " + word : word;
        if (part && c.measureText(next).width > (menu.corners ? 483 : 716)) {
          lines.push(part);
          part = word;
        } else part = next;
      }
      if (part) lines.push(part);
    }
    const contentTop = Math.max(menu.corners ? 215 : 94, 90 + Math.min(5, lines.length) * 31);
    let y = contentTop;
    const full = WIDTH - 2 * padding,
      half = (full - gap) / 2;
    const rows: Button[] = [];
    const add = (item: PanelRow, x: number, width: number, key: string) => {
      rows.push({ ...item, x, y, width, height: buttonHeight, key: menu.title + "/" + key });
    };
    for (const [i, row] of slice.entries()) {
      add(
        row,
        padding,
        full,
        row.id ?? (row.value === undefined ? row.label : "slider-" + this.page + "-" + i),
      );
      y += buttonHeight + gap;
    }
    if (pages > 1) {
      add(
        {
          label: "‹  Previous",
          act:
            this.page > 0
              ? () => {
                  this.page--;
                }
              : undefined,
        },
        padding,
        half,
        "previous",
      );
      add(
        {
          label: `Next  ›    ${this.page + 1}/${pages}`,
          act:
            this.page < pages - 1
              ? () => {
                  this.page++;
                }
              : undefined,
        },
        padding + half + gap,
        half,
        "next",
      );
      y += buttonHeight + gap;
    }
    add({ label: "Main menu", act: home }, padding, half, "home");
    add({ label: "Exit immersive view", act: exit }, padding + half + gap, half, "exit");
    this.rows = rows;
    const ink = JSON.stringify([
      menu.title,
      lines,
      menu.corners,
      rows.map((r) => [r.key, r.label, r.value, !!r.act]),
    ]);
    if (this.last === ink) return;
    this.last = ink;
    const height = y + buttonHeight + padding;
    if (this.canvas.height !== height) {
      this.canvas.height = height;
      // Three textures have immutable storage dimensions once uploaded.
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.mesh.material.map = this.texture;
    }
    this.mesh.scale.y = (this.mesh.scale.x * height) / WIDTH;
    this.mesh.updateWorldMatrix(true, true);
    c.clearRect?.(0, 0, WIDTH, height);
    c.fillStyle = "#13282df7";
    rounded(c, 0, 0, WIDTH, height, 26);
    c.fillStyle = "#74dcc9";
    rounded(c, 24, 14, 64, 4, 2);
    c.fillStyle = "#ffffff";
    c.font = "bold 40px sans-serif";
    c.fillText(menu.title, 24, 64, 720);
    c.fillStyle = "#c8dcde";
    c.font = "27px sans-serif";
    lines.slice(0, 5).forEach((line, i) => c.fillText(line, 25, 92 + i * 31, menu.corners ? 490 : 716));
    if (menu.corners?.length) this.drawCorners(menu.corners);
    for (const r of rows) {
      const footer = r.key.endsWith("/exit") || r.key.endsWith("/home");
      c.fillStyle = footer ? "#23363d" : r.act ? "#2d4b53" : "#1c3339";
      rounded(c, r.x, r.y, r.width, r.height, 12);
      if (r.value !== undefined) {
        c.fillStyle = "#69d4bd";
        rounded(c, r.x + 12, r.y + r.height - 9, Math.max(5, (r.width - 24) * r.value), 4, 2);
      }
      c.fillStyle = r.act ? "#ffffff" : "#a4bbbf";
      c.font = "29px sans-serif";
      c.fillText(r.label, r.x + 15, r.y + 45, r.width - 30);
    }
    this.texture.needsUpdate = true;
  }
  private drawCorners(points: readonly (readonly number[])[]) {
    const c = this.context,
      xs = points.map((p) => p[0]!),
      zs = points.map((p) => p[2]!);
    const x = Math.min(...xs),
      z = Math.min(...zs);
    const scale = Math.min(
      160 / Math.max(0.01, Math.max(...xs) - x),
      94 / Math.max(0.01, Math.max(...zs) - z),
    );
    const plot = points.map((p) => [553 + (p[0]! - x) * scale, 97 + (p[2]! - z) * scale] as const);
    c.strokeStyle = "#8ad8ce";
    c.lineWidth = 3;
    c.beginPath();
    plot.forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
    c.closePath();
    c.stroke();
    plot.forEach(([px, py], i) => {
      c.fillStyle = "#142128";
      c.fillRect(px - 9, py - 14, 20, 25);
      c.fillStyle = "#fff";
      c.fillText(String(i + 1), px - 7, py + 7);
    });
  }
  hit(ray: THREE.Raycaster, extended = false): PanelHit | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateWorldMatrix(true, false);
    this.planeNormal.set(0, 0, 1).transformDirection(this.mesh.matrixWorld);
    if (ray.ray.direction.dot(this.planeNormal) >= -0.005) return null;
    this.rangePlane.setFromNormalAndCoplanarPoint(
      this.planeNormal,
      this.planePoint.setFromMatrixPosition(this.mesh.matrixWorld),
    );
    const point = ray.ray.intersectPlane(this.rangePlane, new THREE.Vector3());
    if (!point || point.distanceTo(ray.ray.origin) > 4) return null;
    const local = this.mesh.worldToLocal(point.clone());
    const x = (local.x + 0.5) * WIDTH,
      y = (0.5 - local.y) * this.canvas.height;
    if (!extended && (x < 0 || x > WIDTH || y < 0 || y > this.canvas.height)) return null;
    const row = this.rows.find((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    return { point, x, y, row };
  }
  private mark(mesh: ReturnType<typeof highlight>, row?: Button) {
    mesh.visible = !!row?.act;
    if (!row) return;
    const h = this.canvas.height;
    mesh.position.set((row.x + row.width / 2) / WIDTH - 0.5, 0.5 - (row.y + row.height / 2) / h, 0.001);
    mesh.scale.set(row.width / WIDTH, row.height / h, 1);
  }
  cursor(index: number, hit: PanelHit | null) {
    this.mark(this.hover[index]!, hit?.row);
  }
  start(source: XRInputSource, hit: PanelHit) {
    if (this.held || !hit.row?.act) return;
    this.held = { source, key: hit.row.key, slider: hit.row.value !== undefined, cancelled: false };
    this.mark(this.pressed, hit.row);
    if (this.held.slider) hit.row.act(THREE.MathUtils.clamp((hit.x - hit.row.x) / hit.row.width, 0, 1));
  }
  owns(source: XRInputSource) {
    return this.held?.source === source;
  }
  drag(source: XRInputSource, hit: PanelHit | null) {
    if (!this.held || !this.owns(source)) return;
    const r = this.rows.find((row) => row.key === this.held!.key);
    if (!r || !r.act || !hit) {
      this.held.cancelled = true;
      this.mark(this.pressed);
      return;
    }
    if (this.held.slider && !this.held.cancelled) r.act(THREE.MathUtils.clamp((hit.x - r.x) / r.width, 0, 1));
    else if (
      hit.x < r.x - 15 ||
      hit.x > r.x + r.width + 15 ||
      hit.y < r.y - 13 ||
      hit.y > r.y + r.height + 13
    ) {
      this.held.cancelled = true;
      this.mark(this.pressed);
    }
  }
  end(source: XRInputSource, hit: PanelHit | null) {
    if (!this.held || !this.owns(source)) return false;
    this.drag(source, hit);
    const hold = this.held,
      r = this.rows.find((row) => row.key === hold.key);
    this.cancel();
    if (hold.cancelled || !r?.act || !hit) return false;
    if (!hold.slider) r.act(THREE.MathUtils.clamp((hit.x - r.x) / r.width, 0, 1));
    return true;
  }
  cancel() {
    this.held = null;
    this.mark(this.pressed);
    for (const h of this.hover) this.mark(h);
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    for (const h of [...this.hover, this.pressed]) {
      h.geometry.dispose();
      h.material.dispose();
    }
  }
}
