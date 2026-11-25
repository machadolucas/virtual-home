import * as THREE from "three";

export interface PanelRow {
  label: string;
  act?: (fraction: number) => void;
  value?: number;
}
export interface PanelPage { title: string; lines: string[]; rows: PanelRow[]; corners?: readonly (readonly number[])[] }

/** The immersive browser does not guarantee DOM overlays. Paint a controller-operable texture. */
export class HeadsetPanel {
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private last = "";
  private actions: Array<{ top: number; bottom: number; run: PanelRow["act"] }> = [];
  private page = 0;
  private title = "";

  constructor() {
    this.canvas.width = 768;
    this.canvas.height = 1024;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("The headset menu could not be created.");
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.694),
      new THREE.MeshBasicMaterial({ map: this.texture, depthTest: false, depthWrite: false, toneMapped: false }));
    this.mesh.renderOrder = 999;
  }

  place(head: THREE.Vector3, orientation: THREE.Quaternion) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    const yaw = Math.atan2(-forward.x, -forward.z);
    this.mesh.rotation.set(0, yaw + 0.28, 0);
    this.mesh.position.set(0, -0.06, -0.95).applyQuaternion(this.mesh.quaternion).add(head);
    this.mesh.updateMatrixWorld(true);
  }

  draw(menu: PanelPage, home: () => void, exit: () => void) {
    if (menu.title !== this.title) { this.page = 0; this.title = menu.title; }
    const pages = Math.max(1, Math.ceil(menu.rows.length / 7));
    this.page = Math.min(this.page, pages - 1);
    const rows = menu.rows.slice(this.page * 7, (this.page + 1) * 7);
    if (pages > 1) rows.push({ label: `Page ${this.page + 1}/${pages}  ·  Previous                      Next`,
      act: fraction => { this.page = (this.page + pages + (fraction < 0.5 ? -1 : 1)) % pages; } });
    rows.push({ label: "Main menu", act: home }, { label: "Exit immersive view", act: exit });
    // Refresh callbacks even when text did not change.
    this.actions = rows.map((row, index) => ({ top: 235 + 76 * index, bottom: 304 + 76 * index, run: row.act }));
    const key = JSON.stringify([menu.title, menu.lines, menu.corners, rows.map(r => [r.label, r.value, !!r.act])]);
    if (key === this.last) return;
    this.last = key;
    const c = this.context;
    c.fillStyle = "#142128"; c.fillRect(0, 0, 768, 1024);
    c.fillStyle = "#fff"; c.font = "bold 42px sans-serif"; c.fillText(menu.title, 26, 65, 716);
    c.font = "28px sans-serif"; c.fillStyle = "#d0dfdf";
    const wrapped: string[] = [];
    for (const line of menu.lines) {
      let part = "";
      for (const word of line.split(" ")) {
        const next = part ? part + " " + word : word;
        if (part && c.measureText(next).width > (menu.corners ? 485 : 710)) { wrapped.push(part); part = word; } else part = next;
      }
      if (part) wrapped.push(part);
    }
    wrapped.slice(0, 4).forEach((line, i) => c.fillText(line, 26, 108 + i * 33, 716));
    if (menu.corners?.length) {
      const points = menu.corners, xs = points.map(p => p[0]!), zs = points.map(p => p[2]!);
      const x = Math.min(...xs), z = Math.min(...zs);
      const scale = Math.min(159 / Math.max(0.01, Math.max(...xs) - x), 95 / Math.max(0.01, Math.max(...zs) - z));
      const plot = points.map(p => [558 + (p[0]! - x) * scale, 108 + (p[2]! - z) * scale] as const);
      c.strokeStyle = "#9fdbd0"; c.lineWidth = 3; c.beginPath();
      plot.forEach(([px, py], i) => i ? c.lineTo(px, py) : c.moveTo(px, py)); c.closePath(); c.stroke();
      c.font = "bold 23px sans-serif";
      plot.forEach(([px, py], i) => { c.fillStyle = "#142128"; c.fillRect(px - 9, py - 14, 21, 25); c.fillStyle = "#fff"; c.fillText(String(i + 1), px - 7, py + 7); });
    }
    rows.forEach((r, i) => {
      const top = this.actions[i]!.top;
      c.fillStyle = r.act ? "#304b57" : "#1c3038"; c.fillRect(20, top, 728, 69);
      if (r.value !== undefined) { c.fillStyle = "#52c4af"; c.fillRect(20, top + 60, 728 * r.value, 7); }
      c.fillStyle = "#fff"; c.font = "30px sans-serif"; c.fillText(r.label, 34, top + 44, 700);
    });
    this.texture.needsUpdate = true;
  }

  press(ray: THREE.Raycaster): boolean {
    const hit = ray.intersectObject(this.mesh, false)[0];
    if (!hit?.uv || !this.mesh.visible) return false;
    const y = (1 - hit.uv.y) * this.canvas.height;
    this.actions.find(a => y >= a.top && y <= a.bottom)?.run?.(THREE.MathUtils.clamp((hit.uv.x * 768 - 20) / 728, 0, 1));
    return true;
  }

  dispose() {
    this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose();
  }
}
