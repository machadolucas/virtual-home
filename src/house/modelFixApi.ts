import { Vector3 } from "three";
import type { HouseRuntime } from "./runtime";
import type { Selection } from "./model/types";
import { MAX_MODEL_FIX_IMAGE_BYTES } from "./modelFixTypes";
import { presentedHouse } from "./xr/presentation";
import type {
  ModelFix, ModelFixCapture, ModelFixPatch, ModelFixScreenshot, ModelFixStatus, ModelFixSummary, ModelFixViewpoint,
  ModelFixViewScreenshot,
} from "./modelFixTypes";

export const MODEL_FIX_SAVED_EVENT = "virtual-home:model-fix-saved";

const messages: Record<string, string> = {
  unknown_route_measurement_target: "This room or active route has changed. Reopen the house and select it again.",
  model_fix_changed: "Someone changed this fix. Reopen it and try again.",
  stale_fingerprint: "The house model changed. Reload the house view and capture again.",
  model_fix_request_too_large: "The screenshot is too large to save.",
  model_fix_screenshot_limit: "This fix already has the maximum number of screenshots.",
  model_fix_resolution_required: "Add a resolution reference before marking this fix resolved.",
  model_fix_resolution_unknown_revision: "This fingerprint does not match a registered revision of the house model.",
  invalid_screenshot_size: "The screenshot is too large or empty.",
  invalid_screenshot_image: "The screenshot could not be read.",
  unauthorized: "Your session expired. Reopen the house after signing in.",
};

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(messages[body?.error ?? ""] ?? "Could not complete the model fix request.");
  }
  return response.json() as Promise<T>;
}

function fixUrl(base: string, id: string) {
  return `${base}/fixes/${encodeURIComponent(id)}`;
}

export function modelFixImageUrl(base: string, fixId: string, entry: ModelFixScreenshot, index: number) {
  return `${fixUrl(base, fixId)}/screenshots/${encodeURIComponent(entry.id)}/${index}`;
}

export async function listModelFixes(base: string, status: ModelFixStatus, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ status });
  if (cursor) params.set("cursor", cursor);
  return responseJson<{ items: ModelFixSummary[]; nextCursor: string | null }>(
    await fetch(`${base}/fixes?${params}`, { cache: "no-store", signal }),
  );
}

export async function getModelFix(base: string, id: string) {
  return responseJson<ModelFix>(await fetch(fixUrl(base, id), { cache: "no-store" }));
}

export async function editModelFix(base: string, id: string, patch: ModelFixPatch) {
  return responseJson<ModelFix>(await fetch(fixUrl(base, id), {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-vh-model-fix": "1" },
    body: JSON.stringify(patch),
  }));
}

export async function saveModelFix(base: string, capture: ModelFixCapture, requestId = crypto.randomUUID(), fixId?: string): Promise<ModelFix> {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ requestId, fingerprint: capture.fingerprint, viewpoint: capture.viewpoint }));
  for (const image of capture.images) form.append("image", image, "capture");
  return await postScreenshot(base, fixId ? `${fixUrl(base, fixId)}/screenshots` : `${base}/fixes`, form);
}

export async function uploadQuestFixScreenshot(base: string, fixId: string, file: File, requestId = crypto.randomUUID()) {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ requestId }));
  form.set("image", file.size > MAX_MODEL_FIX_IMAGE_BYTES ? await shrinkScreenshot(file) : file, file.name);
  return await postScreenshot(base, `${fixUrl(base, fixId)}/screenshots/quest`, form);
}

async function postScreenshot(base: string, url: string, form: FormData) {
  const send = () => fetch(url, {
    method: "POST", headers: { "x-vh-model-fix": "1" }, body: form,
  });
  let response = await send().catch(() => null);
  // An identical retry also covers a response lost after the transaction committed.
  if (!response || response.status >= 500) response = await send();
  const fix = await responseJson<ModelFix>(response);
  window.dispatchEvent(new CustomEvent(MODEL_FIX_SAVED_EVENT, { detail: { base, fixId: fix.id } }));
  return fix;
}

interface CaptureOptions {
  selection?: Selection | null;
  routeMeasurement?: ModelFixViewpoint["routeMeasurement"];
  overlay?: ModelFixViewpoint["overlay"];
  floorId?: string | null;
  roomId?: string | null;
}

export function snapshotModelFixView(
  runtime: HouseRuntime,
  mode: ModelFixViewpoint["mode"],
  camera: ModelFixViewpoint["camera"],
  options?: CaptureOptions,
): Omit<ModelFixCapture, "images"> {
  const state = runtime.store.getState();
  if (!state.modelId || !state.fingerprint) throw new Error("The house model is still loading.");
  const selection = options?.selection !== undefined ? options.selection : state.selection;
  const mr = mode === "mr";
  const overlay = options?.overlay ?? "both";
  const view: ModelFixViewpoint["view"] = mode === "desktop" ? {
    viewMode: state.viewMode,
    wallMode: state.wallMode,
    wallModeExplicit: state.wallModeExplicit,
    activeFloorId: state.activeFloorId,
    roofVisible: state.roofVisible,
    ceilingsVisible: state.ceilingsVisible,
    edgesVisible: state.edgesVisible,
    cut: state.cut,
    explode: { enabled: state.explode.enabled, gap: state.explode.gap },
    layers: state.layers,
    visibleRouteKinds: state.visibleRouteKinds,
    visibleSystems: state.visibleSystems,
    activeRoutesOnly: state.activeRoutesOnly,
    renovationDate: state.renovationDate,
    selection,
    focusSelection: state.focusSelection,
  } : {
    viewMode: mr && options?.floorId ? "floor" : "overview",
    wallMode: "closed",
    wallModeExplicit: true,
    activeFloorId: mr ? options?.floorId ?? null : null,
    roofVisible: mode === "vr",
    ceilingsVisible: mode === "vr",
    edgesVisible: false,
    cut: { enabled: false, y: state.cut.y, vertical: null },
    explode: { enabled: false, gap: state.explode.gap },
    layers: mr ? {
      structure: false, scanReferences: false, yard: false, outdoor: false,
      equipment: false, trees: false, furnishings: false, routes: true, annotations: false,
    } : presentedHouse({ ...state, immersiveMode: "vr" }).layers,
    visibleRouteKinds: mr ? {
      duct: overlay !== "pipes", pipe: overlay !== "ducts",
      cable: false, valve: false, outlet: false, switch: false, junction: false, "access-point": false, other: false,
    } : undefined,
    visibleSystems: mr ? {
      ventilation: true, water: true, electrical: true, network: true, heating: true, drainage: true, other: true,
    } : undefined,
    activeRoutesOnly: mr,
    renovationDate: null,
    selection,
    focusSelection: null,
  };
  const viewpoint: ModelFixViewpoint = {
    mode, camera, view,
    ...(options?.routeMeasurement && { routeMeasurement: options.routeMeasurement }),
    ...(mr ? { overlay } : {}),
    ...(options?.floorId !== undefined || options?.roomId !== undefined
      ? { context: { floorId: options.floorId, roomId: options.roomId } }
      : {}),
  };
  return { fingerprint: state.fingerprint, viewpoint };
}

export async function captureDesktopModelFix(runtime: HouseRuntime): Promise<ModelFixCapture> {
  const captureImage = runtime.captureImage;
  if (!captureImage) throw new Error("The 3D view is not ready for capture.");
  const captured: { view?: ReturnType<typeof snapshotModelFixView> } = {};
  const blob = await captureImage(() => {
    const controls = runtime.controls;
    if (!controls) throw new Error("The 3D view is not ready for capture.");
    const camera = controls.camera;
    captured.view = snapshotModelFixView(runtime, "desktop", {
      position: camera.getWorldPosition(new Vector3()).toArray(),
      target: controls.getTarget(new Vector3(), false).toArray(),
      projection: camera.type === "OrthographicCamera" ? "ortho" : "perspective",
      zoom: camera.zoom,
    });
  });
  if (!captured.view) throw new Error("The view changed before its camera could be saved.");
  const canvas = runtime.canvasEl;
  const large = blob.size > MAX_MODEL_FIX_IMAGE_BYTES || (canvas && canvas.width * canvas.height > 12_000_000);
  return { ...captured.view, images: [large ? await shrinkScreenshot(blob) : blob] };
}

async function shrinkScreenshot(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The screenshot could not be resized.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("The screenshot could not be encoded.")), "image/webp", 0.9);
    });
  } finally {
    bitmap.close();
  }
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export async function reopenModelFixView(runtime: HouseRuntime, screenshot: ModelFixViewScreenshot) {
  const state = runtime.store.getState();
  if (state.fingerprint !== screenshot.fingerprint) throw new Error("This viewpoint was captured with a different model revision.");
  if (!runtime.controls) throw new Error("The 3D view is not ready.");
  const { camera, view } = screenshot.viewpoint;
  const { selection, focusSelection, visibleRouteKinds, visibleSystems, ...presentation } = view ?? {};
  runtime.store.setState({
    ...presentation,
    projection: camera.projection,
    cut: view?.cut ?? state.cut,
    explode: { ...state.explode, ...view?.explode },
    layers: { ...state.layers, ...view?.layers },
    visibleRouteKinds: { ...state.visibleRouteKinds, ...visibleRouteKinds },
    visibleSystems: { ...state.visibleSystems, ...visibleSystems },
  });
  if (selection !== undefined) runtime.select(selection);
  if (focusSelection !== undefined) runtime.store.getState().setFocusSelection(focusSelection);

  // The projection switch remounts controls. Let the rig apply its own projection and restore
  // its outgoing pose before applying the saved camera.
  const cameraType = camera.projection === "ortho" ? "OrthographicCamera" : "PerspectiveCamera";
  const apply = () => {
    const controls = runtime.controls;
    if (!controls || controls.camera.type !== cameraType) return false;
    void controls.setLookAt(...camera.position, ...camera.target, false);
    if (camera.zoom !== undefined) void controls.zoomTo(camera.zoom, false);
    controls.update(0);
    runtime.refreshFocusClipping?.();
    runtime.invalidate();
    return true;
  };
  for (let i = 0; i < 12; i++) {
    await nextFrame();
    if (i > 0 && apply()) return;
  }
  throw new Error("The saved camera could not be restored.");
}
