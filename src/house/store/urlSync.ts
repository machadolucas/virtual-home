/**
 * URL ↔ store synchronisation for `?sel=`, `?floor=` and `?view=`.
 *
 * `history.replaceState`, never `router.push`: the 3D view's selection is not a navigation step,
 * and pushing would fill the back button with camera changes. It survives a reload, which is what
 * makes a selection shareable between the two household members.
 */
import type { FloorId, Projection, Selection, ViewMode } from "@/house/model/types";

export interface UrlState {
  selection: Selection | null;
  activeFloorId: FloorId | null;
  viewMode: ViewMode | null;
  projection: Projection | null;
}

const SELECTION_KINDS = new Set([
  "room",
  "surface",
  "element",
  "floor",
  "building",
  "equipment",
  "route",
  "routePoint",
  "annotation",
]);

const VIEW_MODES = new Set<ViewMode>(["overview", "floor", "plan", "section"]);

export const encodeSelection = (selection: Selection | null): string | null =>
  selection ? `${selection.kind}:${selection.id}` : null;

export function decodeSelection(raw: string | null): Selection | null {
  if (!raw) return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!SELECTION_KINDS.has(kind) || id.length === 0) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return null;
  return { kind, id } as Selection;
}

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const projection = params.get("proj");
  return {
    selection: decodeSelection(params.get("sel")),
    activeFloorId: sanitizeId(params.get("floor")),
    viewMode: view && VIEW_MODES.has(view as ViewMode) ? (view as ViewMode) : null,
    projection: projection === "ortho" || projection === "perspective" ? projection : null,
  };
}

/** The query string this state should produce, given the current one. */
export function writeUrlState(search: string, state: Partial<UrlState>): string {
  const params = new URLSearchParams(search);
  if ("selection" in state) setOrDelete(params, "sel", encodeSelection(state.selection ?? null));
  if ("activeFloorId" in state) setOrDelete(params, "floor", state.activeFloorId ?? null);
  if ("viewMode" in state)
    setOrDelete(params, "view", state.viewMode && state.viewMode !== "overview" ? state.viewMode : null);
  if ("projection" in state)
    setOrDelete(params, "proj", state.projection === "ortho" ? "ortho" : null);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function syncUrl(state: Partial<UrlState>): void {
  if (typeof window === "undefined") return;
  const next = writeUrlState(window.location.search, state);
  const target = `${window.location.pathname}${next}${window.location.hash}`;
  if (target === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.replaceState(window.history.state, "", target);
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value) params.set(key, value);
  else params.delete(key);
}

function sanitizeId(raw: string | null): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw) ? raw : null;
}
