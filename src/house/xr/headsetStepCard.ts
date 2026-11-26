import * as THREE from "three";
import type { HeadsetIllustration, HeadsetStepPin } from "./headsetTasksTypes";

export interface HeadsetStepAnchor {
  position: THREE.Vector3;
  /** Tracking-space front face; when omitted the card faces the person who pins it. */
  facing?: THREE.Vector3;
}

const WIDTH = 1080;
const HEIGHT = 540;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function wrap(context: CanvasRenderingContext2D, input: string, width: number) {
  return input.split(/\n/).flatMap((line) => {
    const result: string[] = [];
    let current = "";
    for (const word of line.trim().split(/\s+/)) {
      const next = current ? current + " " + word : word;
      if (current && context.measureText(next).width > width) { result.push(current); current = word; }
      else current = next;
    }
    if (current) result.push(current);
    return result;
  });
}

function rectangle(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, r: number, fill: string) {
  context.beginPath();
  context.roundRect(x, y, width, height, r);
  context.fillStyle = fill;
  context.fill();
}

type LoadedImage = { source: CanvasImageSource; width: number; height: number; release(): void };

async function illustration(asset: HeadsetIllustration, signal: AbortSignal): Promise<LoadedImage> {
  const url = "/api/attachments/" + encodeURIComponent(asset.attachmentId);
  if (asset.kind === "image") {
    const response = await fetch(url + (asset.preferredVariant ? "?v=" + asset.preferredVariant : ""), { signal, cache: "no-store" });
    if (!response.ok) throw new Error("Illustration unavailable");
    const image = await createImageBitmap(await response.blob());
    return { source: image, width: image.width, height: image.height, release: () => image.close() };
  }
  const lib = await import("pdfjs-dist");
  signal.throwIfAborted();
  lib.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
  const task = lib.getDocument({ url });
  const abort = () => { void task.destroy().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const documentPdf = await task.promise;
    const page = await documentPdf.getPage(asset.page ?? 1);
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1.6, 960 / Math.max(base.width, base.height)) });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    return { source: canvas, width: canvas.width, height: canvas.height, release: () => { canvas.width = canvas.height = 0; } };
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy().catch(() => undefined);
  }
}

/** An independent, motionless card; the main menu may close while it remains beside the unit. */
export class HeadsetStepCard {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly direction = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private request: AbortController | null = null;
  private targetId: string | null = null;
  private key = "";
  private anchorWasExplicit = false;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The pinned instruction card could not be created.");
    this.context = context;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(.65, .325), new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
    }));
    this.mesh.name = "vh-headset-step";
    this.mesh.visible = false;
    this.mesh.renderOrder = 997;
    this.mesh.matrixAutoUpdate = false;
  }

  show(pin: HeadsetStepPin, head: THREE.Vector3, orientation: THREE.Quaternion, anchor?: HeadsetStepAnchor) {
    const resituated = !!anchor && (!this.anchorWasExplicit || !this.mesh.position.equals(anchor.position));
    if (!this.mesh.visible || this.targetId !== pin.target.id || resituated) this.place(head, orientation, anchor);
    this.anchorWasExplicit = !!anchor;
    this.mesh.visible = true;
    this.targetId = pin.target.id;
    const key = JSON.stringify([pin.taskTitle, pin.title, pin.body, pin.warning, pin.index, pin.total, pin.illustration]);
    if (key === this.key) return;
    this.key = key;
    this.request?.abort();
    this.request = null;
    this.paint(pin, null, false);
    if (!pin.illustration) return;
    const controller = new AbortController();
    this.request = controller;
    void illustration(pin.illustration, controller.signal).then((image) => {
      try { if (!controller.signal.aborted) this.paint(pin, image, false); }
      finally { image.release(); }
    }, () => {
      if (!controller.signal.aborted) this.paint(pin, null, true);
    }).finally(() => {
      if (this.request === controller) this.request = null;
    });
  }

  private place(head: THREE.Vector3, orientation: THREE.Quaternion, anchor?: HeadsetStepAnchor) {
    if (anchor) {
      this.mesh.position.copy(anchor.position);
      if (anchor.facing) this.direction.copy(anchor.facing);
      else this.direction.subVectors(head, anchor.position);
      const yaw = this.direction.x * this.direction.x + this.direction.z * this.direction.z > .0001
        ? Math.atan2(this.direction.x, this.direction.z) : 0;
      this.mesh.quaternion.setFromAxisAngle(this.axis, yaw);
    } else {
      this.direction.set(0, 0, -1).applyQuaternion(orientation);
      const yaw = Math.atan2(-this.direction.x, -this.direction.z);
      this.mesh.quaternion.setFromAxisAngle(this.axis, yaw);
      this.mesh.position.set(.32, -.08, -1.04).applyQuaternion(this.mesh.quaternion).add(head);
    }
    this.mesh.updateMatrix();
  }

  private paint(pin: HeadsetStepPin, image: LoadedImage | null, failed: boolean) {
    const c = this.context;
    c.clearRect(0, 0, WIDTH, HEIGHT);
    rectangle(c, 1, 1, WIDTH - 2, HEIGHT - 2, 26, "#152735");
    c.lineWidth = 2;
    c.strokeStyle = "#577381";
    c.stroke();
    c.fillStyle = "#92d7c9";
    c.font = `640 27px ${FONT}`;
    c.fillText(`${pin.taskTitle} · Step ${pin.index} of ${pin.total}`, 30, 57, WIDTH - 60);
    c.fillStyle = "#f1f8fa";
    c.font = `680 43px ${FONT}`;
    c.fillText(pin.title, 30, 115, WIDTH - 60);
    const textWidth = pin.illustration ? 570 : WIDTH - 60;
    c.font = `500 30px ${FONT}`;
    const warning = pin.warning ? wrap(c, pin.warning, textWidth).slice(0, 3) : [];
    c.fillStyle = "#ffc993";
    warning.forEach((text, index) => c.fillText(text, 31, 166 + index * 38, textWidth));
    c.fillStyle = "#d6e6ed";
    const body = wrap(c, pin.body, textWidth);
    const max = Math.max(1, 9 - warning.length);
    body.slice(0, max).forEach((text, index) => c.fillText(text, 31, 166 + (index + warning.length) * 38, textWidth));
    if (body.length > max) {
      c.fillStyle = "#9eb4bf";
      c.font = `500 24px ${FONT}`;
      c.fillText("Full instructions in the maintenance menu", 31, 518, textWidth);
    }
    if (pin.illustration) {
      const x = 629, y = 145, width = 421, height = 325;
      rectangle(c, x, y, width, height, 14, "#0e1a23");
      if (image) {
        const scale = Math.min((width - 10) / image.width, (height - 10) / image.height);
        const w = image.width * scale, h = image.height * scale;
        c.drawImage(image.source, x + (width - w) / 2, y + (height - h) / 2, w, h);
      } else {
        c.fillStyle = "#a9bdc9";
        c.font = `530 26px ${FONT}`;
        c.fillText(failed ? "Illustration unavailable" : "Loading illustration…", x + 18, y + height / 2);
      }
      c.fillStyle = "#b8d2da";
      c.font = `540 24px ${FONT}`;
      c.fillText(`${pin.illustration.label}${pin.illustration.page ? ` · Page ${pin.illustration.page}` : ""}`, x, 505, width);
    }
    this.texture.needsUpdate = true;
  }

  hide() {
    this.request?.abort();
    this.request = null;
    this.key = "";
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
