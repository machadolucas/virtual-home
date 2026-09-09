"use client";

import type * as THREE from "three";
import type { HouseBackground } from "./model/background";

export interface CaptureHouseViewOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  host: HTMLElement;
  labelHost: HTMLElement | null;
  background: HouseBackground;
}

/** Called in the viewer's frame, after label projection. Copy synchronously before WebGL clears. */
export async function captureHouseView(opts: CaptureHouseViewOptions): Promise<Blob> {
  const { renderer, scene, camera, host } = opts;
  const output = document.createElement("canvas");
  output.width = renderer.domElement.width;
  output.height = renderer.domElement.height;
  if (!output.width || !output.height || renderer.getContext().isContextLost())
    throw new Error("The 3D view is not ready for capture.");
  const context = output.getContext("2d");
  if (!context) throw new Error("Your browser could not create the image.");
  paintBackground(context, output.width, output.height, opts.background, getComputedStyle(host).backgroundColor);

  const hidden: Array<{ object: THREE.Object3D; visible: boolean }> = [];
  scene.traverse((object) => {
    if (object.name !== "vh-snap-indicator" && object.name !== "vh-route-handles") return;
    hidden.push({ object, visible: object.visible });
    object.visible = false;
  });
  const previousTarget = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    // drawImage composites transparent pixels; putImageData would erase the background.
    context.drawImage(renderer.domElement, 0, 0);
  } finally {
    for (const entry of hidden) entry.object.visible = entry.visible;
    renderer.setRenderTarget(previousTarget);
  }
  paintLabels(context, opts.labelHost, host, output.width, output.height);
  return new Promise((resolve, reject) => {
    output.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser could not encode the image.")), "image/png");
  });
}

export function paintBackground(context: CanvasRenderingContext2D, width: number, height: number,
  background: HouseBackground, themeColor: string): void {
  if (background.mode === "gradient") {
    const [x0, y0, x1, y1] = gradientEndpoints(width, height, background.angleDeg ?? 180);
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    context.fillStyle = gradient;
  } else context.fillStyle = background.mode === "solid" ? background.color : themeColor;
  context.fillRect(0, 0, width, height);
}

/** CSS linear gradients span the projection of the box onto their direction, not its diagonal. */
export function gradientEndpoints(width: number, height: number, angleDeg: number): [number, number, number, number] {
  const angle = angleDeg * Math.PI / 180;
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  return [width / 2 - dx * half, height / 2 - dy * half, width / 2 + dx * half, height / 2 + dy * half];
}

/** The label pool contains single-line text chips and cluster badges, all in CSS pixel units. */
function paintLabels(context: CanvasRenderingContext2D, labelHost: HTMLElement | null,
  host: HTMLElement, width: number, height: number): void {
  if (!labelHost) return;
  const hostRect = host.getBoundingClientRect();
  if (!hostRect.width || !hostRect.height) return;
  context.save();
  context.scale(width / hostRect.width, height / hostRect.height);
  for (const label of labelHost.querySelectorAll<HTMLElement>(".vh-label, .vh-label-cluster")) {
    const style = getComputedStyle(label);
    if (label.hidden || style.display === "none" || style.visibility === "hidden") continue;
    const rect = label.getBoundingClientRect();
    const x = rect.left - hostRect.left, y = rect.top - hostRect.top;
    if (!rect.width || !rect.height || x > hostRect.width || y > hostRect.height || x + rect.width < 0 || y + rect.height < 0) continue;
    context.save();
    context.globalAlpha = Number(style.opacity);
    context.beginPath();
    context.roundRect(x, y, rect.width, rect.height, Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.height / 2));
    context.fillStyle = style.backgroundColor;
    context.fill();
    const border = parseFloat(style.borderTopWidth) || 0;
    if (border) {
      context.lineWidth = border;
      context.strokeStyle = style.borderTopColor;
      context.stroke();
    }
    context.fillStyle = style.color;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.textContent ?? "", x + rect.width / 2, y + rect.height / 2,
      Math.max(1, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2 * border));
    context.restore();
  }
  context.restore();
}
