import * as THREE from "three";
import type { Room, Route } from "@/house/model/types";
import type { PanelPage } from "./panel";
import type { AlignmentWall } from "./roomAlignment";
import { isApproximateRoute, type buildMixedRealityOverlay } from "./mixedOverlay";
import { pickWallPatch, wallCrossings, type WallCrossing, type WallPatch } from "./wallPatch";

const PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
const PATCH_COLOR = 0x77dfd0;
const PHOTO = 0xffffff;

export const installationPhotoPath = (id: string, variant: "web" | "thumb") =>
  `/api/attachments/${encodeURIComponent(id)}?v=${variant}`;

export async function readInstallationPhoto(id: string, signal: AbortSignal): Promise<ImageBitmap> {
  if (!id || id === "." || id === "..") throw new Error("The linked installation photo preview is unavailable.");
  for (const variant of ["web", "thumb"] as const) {
    const response = await fetch(installationPhotoPath(id, variant), {
      credentials: "same-origin", redirect: "error", cache: "no-store", signal,
    });
    if (!response.ok || !/^image\/(jpeg|png|webp)$/i.test(response.headers.get("content-type") ?? "") ||
      Number(response.headers.get("content-length") ?? 0) > PHOTO_LIMIT_BYTES) continue;
    const image = await response.blob();
    if (image.size > PHOTO_LIMIT_BYTES || signal.aborted) continue;
    const bitmap = await createImageBitmap(image, { imageOrientation: "flipY" }).catch(() => null);
    if (bitmap) {
      if (!signal.aborted) return bitmap;
      bitmap.close();
    }
  }
  throw new Error("The linked installation photo preview is unavailable.");
}

function clear(group: THREE.Group) {
  group.traverse((node) => {
    const item = node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    item.geometry?.dispose();
    item.material?.map?.dispose();
    item.material?.dispose();
  });
  group.clear();
}

function corner(patch: WallPatch, u: number, v: number, depth: number) {
  return new THREE.Vector3(...patch.origin).addScaledVector(new THREE.Vector3(...patch.along), u)
    .addScaledVector(new THREE.Vector3(...patch.behind), depth).add(new THREE.Vector3(0, v, 0));
}

const certaintyLabel = (route: Route) =>
  `${route.certainty[0]?.toUpperCase() ?? ""}${route.certainty.slice(1)} · ${isApproximateRoute(route) ? "approximate path" : "documented path"}`;
const routeType = (route: Route) => {
  if (route.kind !== "duct") return "Pipe";
  if (route.medium === "supply_air") return "Supply";
  if (route.medium === "extract_air") return "Extract";
  return "Duct";
};

export class WallInspector {
  readonly group = new THREE.Group();
  aiming = false;
  private selected: WallPatch | null = null;
  private readonly outline = new THREE.Group();
  private readonly crossingsLayer = new THREE.Group();
  private readonly photo = new THREE.Group();
  private photoAbort: AbortController | null = null;
  private bitmap: ImageBitmap | null = null;
  private notice = "";
  private runs: readonly Route[] = [];
  private crossings: WallCrossing[] = [];
  private detailedCrossing: WallCrossing | null = null;

  constructor(private readonly room: Room, private readonly walls: AlignmentWall[],
    private readonly overlay: ReturnType<typeof buildMixedRealityOverlay>) {
    this.group.name = "vh-mr-wall-inspector";
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(this.outline, this.crossingsLayer, this.photo);
  }

  get active() { return this.aiming || this.selected !== null; }

  start(): void {
    this.clear();
    this.aiming = true;
    this.notice = "Aim at a wall from inside this room and confirm the patch.";
  }

  probe(ray: THREE.Ray, matrix: THREE.Matrix4, target: THREE.Vector3): THREE.Vector3 | null {
    const patch = this.aiming && pickWallPatch(this.room, this.walls, ray, matrix);
    return patch ? target.fromArray(patch.hit).applyMatrix4(matrix) : null;
  }

  confirm(ray: THREE.Ray, matrix: THREE.Matrix4) {
    if (!this.aiming) return;
    const patch = pickWallPatch(this.room, this.walls, ray, matrix);
    if (!patch) { this.notice = "Point at a wall face inside the aligned room, away from the menu."; return; }
    this.selected = patch;
    this.aiming = false;
    this.notice = "";
    this.overlay.setWallPatch(patch);
    this.drawOutline(patch);
    this.syncRoutes();
    return true;
  }

  frame(matrix: THREE.Matrix4 | null): void {
    this.group.visible = !!matrix && this.selected !== null;
    if (!matrix) {
      if (this.active) this.clear();
      return;
    }
    if (!this.selected) return;
    this.group.matrix.copy(matrix);
    this.group.matrixWorldNeedsUpdate = true;
    this.syncRoutes();
  }

  private drawOutline(patch: WallPatch) {
    clear(this.outline);
    const points = [
      corner(patch, 0, 0, -0.008), corner(patch, patch.widthM, 0, -0.008),
      corner(patch, patch.widthM, patch.heightM, -0.008), corner(patch, 0, patch.heightM, -0.008),
    ];
    const contour = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: PATCH_COLOR, depthWrite: false }));
    this.outline.add(contour);
    const fill = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3))
      .setIndex([0, 1, 2, 0, 2, 3]);
    this.outline.add(new THREE.Mesh(fill,
      new THREE.MeshBasicMaterial({ color: PATCH_COLOR, side: THREE.DoubleSide, transparent: true, opacity: 0.08, depthWrite: false })));
  }

  private syncRoutes() {
    const routes = this.overlay.patchRoutes;
    if (this.runs === routes) return;
    this.runs = routes;
    const hit = this.selected?.hit;
    const gap = ({ upperPoint, lowerPoint }: WallCrossing) => hit ? Math.hypot(
      hit[0] - upperPoint[0], hit[1] - (upperPoint[1] + lowerPoint[1]) / 2, hit[2] - upperPoint[2],
    ) : 0;
    this.crossings = wallCrossings(routes).sort((a, b) => gap(a) - gap(b)).slice(0, 12);
    this.detailedCrossing = null;
    clear(this.crossingsLayer);
    for (const { upperPoint, lowerPoint, separationM } of this.crossings) {
      if (separationM <= 0.005) continue;
      const points = [new THREE.Vector3(...upperPoint), new THREE.Vector3(...lowerPoint)];
      this.crossingsLayer.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false })));
    }
  }

  menu(registrationM: number, close: () => void): PanelPage {
    const registration = `Room alignment ${(registrationM * 100).toFixed(1)} cm`;
    const patch = this.selected;
    if (!patch) return { title: "Point at a wall", lines: [this.notice, registration], rows: [], back: close, close };
    const pass = this.detailedCrossing;
    if (pass) {
      const back = () => { this.detailedCrossing = null; };
      const height = (point: Route["points"][number]) => `${Math.round((point[1] - this.room.floorElevation) * 100)} cm above room floor`;
      return { title: "Route crossing", back, close, lines: [
        pass.separationM <= 0.005 ? "Same model height" : `${Math.round(pass.separationM * 100)} cm vertical separation in the model`,
        `${pass.separationM <= 0.005 ? "Run" : "Above"} · ${pass.upper.name}`,
        `${height(pass.upperPoint)} · ${certaintyLabel(pass.upper)}`,
        `${pass.separationM <= 0.005 ? "Run" : "Below"} · ${pass.lower.name}`,
        `${height(pass.lowerPoint)} · ${certaintyLabel(pass.lower)}`, registration,
      ], rows: [] };
    }
    const routes = [...new Map(this.runs.map((route) => [route.id, route])).values()];
    return {
      title: "Wall patch",
      lines: [
        registration,
        `${Math.round(patch.widthM * 100)} × ${Math.round(patch.heightM * 100)} cm patch · up to ${Math.round(patch.depthM * 100)} cm behind the modeled wall`,
        routes.length ? "" : "No modeled runs in this patch.",
        this.notice,
      ].filter(Boolean),
      rows: [
        ...this.crossings.map((pass, index) => ({
          id: `crossing-${index}`,
          label: pass.separationM <= 0.005 ? "Crossing · same model height"
            : `${Math.round(pass.separationM * 100)} cm · ${routeType(pass.lower)} below ${routeType(pass.upper)}`,
          detail: "Model crossing", act: () => { this.detailedCrossing = pass; },
        })),
        ...routes.flatMap((route) => [
          { id: `trace-${route.id}`,
            label: this.overlay.focusedId === route.id ? `Stop tracing ${route.name}` : `Trace ${route.name}`,
            detail: certaintyLabel(route), act: () => {
              const focused = this.overlay.focusedId;
              if (focused && focused !== route.id) this.overlay.clearFocus();
              this.overlay.toggleFocus(route.id);
            } },
          ...route.photoIds.map((id, index) => ({ id: `photo-${route.id}-${index}`, icon: "camera" as const,
            label: (route.photoIds.length > 1 ? `Photo ${index + 1} of ${route.photoIds.length}` : "Installation photo") + ` · ${route.name}`,
            act: () => void this.openPhoto(id) })),
        ]),
        ...(this.bitmap || this.photoAbort ? [{ label: "Close installation photo", act: () => { this.closePhoto(); this.notice = ""; } }] : []),
        { label: "Choose another patch", act: () => this.start() },
      ],
      back: close, close,
    };
  }

  private async openPhoto(id: string) {
    this.closePhoto();
    const patch = this.selected;
    if (!patch) return;
    const controller = new AbortController();
    this.photoAbort = controller;
    this.notice = "Opening installation photo…";
    try {
      const bitmap = await readInstallationPhoto(id, controller.signal);
      if (this.photoAbort !== controller) { bitmap.close(); return; }
      this.bitmap = bitmap;
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      const shape = bitmap.width / bitmap.height;
      const width = Math.min(0.95, 0.62 * shape), height = width / shape;
      const card = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
        new THREE.MeshBasicMaterial({ map: texture, color: PHOTO, toneMapped: false }));
      card.position.copy(corner(patch, patch.widthM / 2, patch.heightM / 2, -0.28));
      card.position.y = THREE.MathUtils.clamp(card.position.y, this.room.floorElevation + 0.65,
        this.room.floorElevation + (this.room.ceilingHeight ?? 2.6) - 0.4);
      const inward = new THREE.Vector3(...patch.behind).negate();
      card.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), inward);
      this.photo.add(card);
      this.notice = "Installation photo open.";
    } catch (error) {
      if (this.photoAbort === controller) this.notice = error instanceof Error ? error.message : "Could not open the installation photo.";
    } finally {
      if (this.photoAbort === controller) this.photoAbort = null;
    }
  }

  private closePhoto() {
    this.photoAbort?.abort();
    this.photoAbort = null;
    clear(this.photo);
    this.bitmap?.close();
    this.bitmap = null;
  }

  clear(): void {
    this.aiming = false;
    this.selected = null;
    this.group.visible = false;
    this.notice = "";
    this.overlay.setWallPatch(null);
    this.runs = [];
    this.crossings = [];
    this.detailedCrossing = null;
    clear(this.outline);
    clear(this.crossingsLayer);
    this.closePhoto();
  }

  dispose() { this.clear(); this.group.removeFromParent(); }
}
