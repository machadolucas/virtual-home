"use client";
/**
 * Which of the workspace's three side panels are collapsed, so the 3D view can have the space.
 *
 * Per-viewer convenience, so it lives in `localStorage` rather than in the database or the URL: it
 * is not household data, it should not travel between people, and a shared link should open with
 * the recipient's own layout. Every access is wrapped — a private window, cleared site data or a
 * browser that blocks storage must degrade to "nothing collapsed", never throw.
 *
 * Exposed through `useSyncExternalStore` with a distinct server snapshot: the server cannot know
 * the stored value, so it renders everything open and the client swaps in the real one during
 * hydration. Reading storage in the initialiser would be a hydration mismatch; reading it in an
 * effect would be a `setState` in an effect.
 */
import { useSyncExternalStore } from "react";

export const PANEL_IDS = ["tree", "inspector", "controls"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export type PanelState = { readonly [P in PanelId]: boolean };

const STORAGE_KEY = "vh.house.panels";
const ALL_OPEN: PanelState = { tree: false, inspector: false, controls: false };

function read(): PanelState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return ALL_OPEN;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return ALL_OPEN;
    const source = parsed as Record<string, unknown>;
    return {
      tree: source["tree"] === true,
      inspector: source["inspector"] === true,
      controls: source["controls"] === true,
    };
  } catch {
    return ALL_OPEN;
  }
}

/**
 * The snapshot has to be referentially stable or `useSyncExternalStore` re-renders forever, so it
 * is cached and only replaced when the value actually changes.
 */
let cache: PanelState | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): PanelState {
  cache ??= read();
  return cache;
}

function getServerSnapshot(): PanelState {
  return ALL_OPEN;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function togglePanel(id: PanelId): void {
  const next: PanelState = { ...getSnapshot(), [id]: !getSnapshot()[id] };
  cache = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A viewer who cannot persist the choice still gets it for this session.
  }
  for (const listener of listeners) listener();
}

export interface PanelLayout {
  collapsed: PanelState;
  toggle(id: PanelId): void;
}

export function usePanelLayout(): PanelLayout {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { collapsed, toggle: togglePanel };
}
