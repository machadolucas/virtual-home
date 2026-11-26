import * as THREE from "three";

export type HeadsetNoticeTone = "arrival" | "info" | "success" | "warning";
export interface HeadsetNoticeMessage {
  title: string;
  detail?: string;
  tone?: HeadsetNoticeTone;
  /** Persistent when null. Timing starts from the supplied animation-frame timestamp. */
  durationMs?: number | null;
}

const WIDTH = 640;
const HEIGHT = 166;
const PANEL_WIDTH_M = .47;
const DEFAULT_DURATION_MS = 3_200;
const FADE_MS = 580;
const PALETTE = {
  arrival: { accent: "#9bddcd", fill: "#214945", border: "#587f77" },
  info: { accent: "#b8d9ef", fill: "#2a475b", border: "#536c81" },
  success: { accent: "#bce7ad", fill: "#304c3a", border: "#658666" },
  warning: { accent: "#f7c887", fill: "#4d3b30", border: "#a27d54" },
} satisfies Record<HeadsetNoticeTone, { accent: string; fill: string; border: string }>;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function rounded(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, radius);
}

function label(c: CanvasRenderingContext2D, text: string, y: number, maxWidth: number) {
  let length = text.length;
  while (length > 0 && c.measureText(text.slice(0, length) + (length < text.length ? "…" : "")).width > maxWidth) length--;
  c.fillText(text.slice(0, length) + (length < text.length ? "…" : ""), 112, y);
}

function drawIcon(c: CanvasRenderingContext2D, tone: HeadsetNoticeTone) {
  c.beginPath();
  if (tone === "arrival") {
    c.moveTo(62, 105);
    c.quadraticCurveTo(43, 87, 43, 76);
    c.arc(62, 76, 19, Math.PI, 2 * Math.PI);
    c.quadraticCurveTo(81, 87, 62, 105);
    c.closePath();
    c.moveTo(68, 76);
    c.arc(62, 76, 6, 0, 2 * Math.PI);
  } else if (tone === "success") {
    c.moveTo(48, 83);
    c.lineTo(58, 93);
    c.lineTo(77, 73);
  } else if (tone === "warning") {
    c.moveTo(62, 64);
    c.lineTo(43, 99);
    c.lineTo(81, 99);
    c.closePath();
    c.moveTo(62, 77);
    c.lineTo(62, 86);
    c.moveTo(62, 92);
    c.lineTo(62, 93);
  } else {
    c.arc(62, 83, 18, 0, 2 * Math.PI);
    c.moveTo(62, 82);
    c.lineTo(62, 92);
    c.moveTo(62, 75);
    c.lineTo(62, 76);
  }
  c.stroke();
}

function paint(c: CanvasRenderingContext2D, title: string, detail: string, tone: HeadsetNoticeTone) {
  const colors = PALETTE[tone];
  c.clearRect(0, 0, WIDTH, HEIGHT);
  c.fillStyle = "#071019e0";
  rounded(c, 5, 9, WIDTH - 10, HEIGHT - 13, 25);
  c.fill();
  const base = c.createLinearGradient(12, 4, WIDTH - 10, HEIGHT);
  base.addColorStop(0, "#253d4c");
  base.addColorStop(.5, "#172833");
  base.addColorStop(1, "#12212c");
  c.fillStyle = base;
  rounded(c, 5, 3, WIDTH - 10, HEIGHT - 14, 23);
  c.fill();
  c.lineWidth = 2;
  c.strokeStyle = colors.border;
  c.stroke();

  c.fillStyle = colors.fill;
  rounded(c, 27, 47, 70, 70, 19);
  c.fill();
  c.strokeStyle = colors.accent;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.lineWidth = 3;
  drawIcon(c, tone);
  c.fillStyle = "#f4f9fc";
  c.font = `680 37px ${FONT}`;
  label(c, title, detail ? 76 : 94, 488);
  if (detail) {
    c.fillStyle = "#c6d9e4";
    c.font = `500 25px ${FONT}`;
    label(c, detail, 114, 488);
  }
}

/** One spatially placed card. Pose and texture change only when a new message is displayed. */
export class HeadsetNotice {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly bearing = new THREE.Vector3();
  private key = "";
  private lifetime: number | null = null;
  private expiresAt = 0;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The headset notice could not be created.");
    this.context = context;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH_M, PANEL_WIDTH_M * HEIGHT / WIDTH),
      new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      }),
    );
    this.mesh.name = "vh-xr-notice";
    this.mesh.renderOrder = 1002;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  show(message: HeadsetNoticeMessage, head: THREE.Vector3, orientation: THREE.Quaternion, now = performance.now()) {
    const title = message.title.trim().slice(0, 180);
    if (!title) { this.hide(); return; }
    const detail = message.detail?.trim().slice(0, 240) ?? "";
    const tone = message.tone ?? "info";
    const duration = message.durationMs;
    const lifetime = duration === null ? null : typeof duration === "number" && Number.isFinite(duration)
      ? Math.max(200, duration) : DEFAULT_DURATION_MS;
    const key = JSON.stringify([title, detail, tone]);
    if (key !== this.key) {
      paint(this.context, title, detail, tone);
      this.texture.needsUpdate = true;
    } else if (this.mesh.visible) {
      if (this.lifetime !== lifetime) this.resetLifetime(lifetime, now);
      return;
    }

    // Capture a stable tracking-space pose. Ignore roll and stay near eye level when the head
    // comes up after aiming a landing or checking the physical floor.
    this.forward.set(0, 0, -1).applyQuaternion(orientation);
    const pitch = THREE.MathUtils.clamp(this.forward.y, -.24, .24);
    this.bearing.set(1, 0, 0).applyQuaternion(orientation);
    const yaw = Math.hypot(this.forward.x, this.forward.z) > .01
      ? Math.atan2(-this.forward.x, -this.forward.z)
      : Math.atan2(-this.bearing.z, this.bearing.x);
    this.mesh.quaternion.setFromAxisAngle(this.up, yaw);
    this.mesh.position.set(0, .26 + pitch * .5, -1.02).applyQuaternion(this.mesh.quaternion).add(head);
    this.mesh.updateMatrix();
    this.key = key;
    this.resetLifetime(lifetime, now);
    this.mesh.visible = true;
  }

  private resetLifetime(lifetime: number | null, now: number) {
    this.lifetime = lifetime;
    this.expiresAt = lifetime === null ? Infinity : now + lifetime;
    this.mesh.material.opacity = 1;
  }

  tick(now: number) {
    if (!this.mesh.visible || this.lifetime === null) return;
    const remaining = this.expiresAt - now;
    if (remaining <= 0) { this.hide(); return; }
    const fade = Math.min(FADE_MS, this.lifetime * .45);
    if (remaining < fade) {
      const opacity = THREE.MathUtils.smoothstep(remaining, 0, fade);
      if (opacity !== this.mesh.material.opacity) this.mesh.material.opacity = opacity;
    }
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.hide();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
