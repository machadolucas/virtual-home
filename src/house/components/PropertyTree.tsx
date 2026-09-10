"use client";
/**
 * The non-3D route to everything: buildings → floors → rooms, equipment, infrastructure and
 * furniture, plus an `Outside` branch for outdoor zones and equipment placed out there.
 *
 * `role="tree"` with a **roving `tabIndex`**: one tab stop for the whole tree, arrows navigate,
 * `Home`/`End` jump, `Enter`/`Space` selects, typing jumps to a matching label. Selecting here
 * writes the store, and the canvas highlight follows — so a keyboard-only user can isolate a
 * floor, select a room and read the inspector without touching the 3D view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPropertyTree,
  initiallyExpandedPropertyTreeNodes,
  repairedPropertyTreeFocus,
  routeFloorIds,
  type PropertyTreeNode,
} from "@/house/model/propertyTree";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useFurnishings } from "./furnishings/FurnishingsProvider";

export function PropertyTree() {
  const runtime = useHouseRuntime();
  const { items: furnishings, requestEdit } = useFurnishings();
  const { index, placements, routes, selection, labelPreferences } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      placements: s.placements,
      routes: s.routes,
      selection: s.selection,
      labelPreferences: s.labelPreferences,
    })),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string>("");
  const initialisedModel = useRef<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const previousNodes = useRef<ReadonlyMap<string, PropertyTreeNode>>(new Map());
  const treeHadFocus = useRef(false);

  const nodes = useMemo(() => {
    if (!index) return new Map<string, PropertyTreeNode>();
    return buildPropertyTree({ index, placements, routes, furnishings, labelPreferences });
  }, [index, placements, routes, furnishings, labelPreferences]);

  const visible = useMemo(() => {
    const out: PropertyTreeNode[] = [];
    const walk = (id: string) => {
      const node = nodes.get(id);
      if (!node) return;
      out.push(node);
      if (!expanded.has(id)) return;
      for (const child of node.children) walk(child);
    };
    for (const node of nodes.values()) if (node.parent === null) walk(node.id);
    return out;
  }, [nodes, expanded]);

  // On first load, expose the useful working level: buildings, their floors, and the rooms below
  // them. Room surfaces remain collapsed because they are detail, not everyday navigation.
  useEffect(() => {
    if (!index || initialisedModel.current === index.modelId || nodes.size === 0) return;
    initialisedModel.current = index.modelId;
    setExpanded(
      initiallyExpandedPropertyTreeNodes(nodes),
    );
    setFocusId([...nodes.values()].find((node) => node.parent === null)?.id ?? "");
  }, [index, nodes]);

  useEffect(() => {
    const rememberFocusOwner = (event: FocusEvent) => {
      treeHadFocus.current = !!listRef.current?.contains(event.target as Node);
    };
    document.addEventListener("focusin", rememberFocusOwner);
    return () => document.removeEventListener("focusin", rememberFocusOwner);
  }, []);

  useEffect(() => {
    const prior = previousNodes.current;
    previousNodes.current = nodes;
    if (visible.length === 0) return;
    const repaired = repairedPropertyTreeFocus(nodes, prior, visible, focusId);
    if (repaired === focusId) return;
    setFocusId(repaired);
    if (!treeHadFocus.current) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-node="${repaired}"]`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, nodes, visible]);

  const toggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const activate = useCallback(
    (node: PropertyTreeNode) => {
      const state = runtime.store.getState();
      if (node.kind === "section" || node.kind === "route-group") {
        toggle(node.id);
        return;
      }
      if (node.furnishingId) {
        if (node.floorId && state.activeFloorId !== node.floorId) state.isolateFloor(node.floorId);
        requestEdit(node.furnishingId);
        return;
      }
      if (node.id === "outside") {
        state.isolateFloor(null);
        runtime.select(null);
        void runtime.camera?.overview();
        return;
      }
      if (node.selection?.kind === "building") {
        state.isolateFloor(null);
        runtime.select(node.selection, { frame: true });
        return;
      }
      if (node.selection?.kind === "floor") {
        state.setProjection("perspective");
        state.isolateFloor(node.selection.id);
        runtime.select(node.selection, { focus: true });
        void runtime.camera?.frameFloor(node.selection.id);
        return;
      }
      if (node.selection?.kind === "route") {
        const route = routes.find((candidate) => candidate.id === node.selection!.id);
        const floorIds = route ? [...routeFloorIds(route)] : [];
        state.isolateFloor(floorIds.length === 1 ? floorIds[0]! : null);
        state.setLayer("routes", true);
        if (route && !state.visibleSystems[route.system]) state.toggleSystem(route.system);
        if (route && !state.visibleRouteKinds[route.kind]) state.toggleRouteKind(route.kind);
        runtime.select(node.selection, { frame: true });
        return;
      }
      if (node.floorId && state.activeFloorId !== node.floorId) state.isolateFloor(node.floorId);
      runtime.select(node.selection, { frame: node.selection !== null });
    },
    [requestEdit, routes, runtime, toggle],
  );

  // Keep the focused row in view without stealing focus from the page.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-node="${focusId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const i = visible.findIndex((n) => n.id === focusId);
    const node = visible[i];
    if (!node) return;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        setFocusId(visible[Math.min(i + 1, visible.length - 1)]?.id ?? focusId);
        break;
      case "ArrowUp":
        setFocusId(visible[Math.max(i - 1, 0)]?.id ?? focusId);
        break;
      case "ArrowRight":
        if (node.children.length && !expanded.has(node.id)) toggle(node.id, true);
        else if (node.children.length) setFocusId(node.children[0] ?? focusId);
        break;
      case "ArrowLeft":
        if (node.children.length && expanded.has(node.id)) toggle(node.id, false);
        else if (node.parent) setFocusId(node.parent);
        break;
      case "Home":
        setFocusId(visible[0]?.id ?? focusId);
        break;
      case "End":
        setFocusId(visible[visible.length - 1]?.id ?? focusId);
        break;
      case "Enter":
      case " ":
        activate(node);
        break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const now = Date.now();
          const state = typeahead.current;
          state.text = now - state.at < 700 ? state.text + event.key.toLowerCase() : event.key.toLowerCase();
          state.at = now;
          const match = visible.find((n) => n.label.toLowerCase().startsWith(state.text));
          if (match) setFocusId(match.id);
        } else handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  if (!index) return null;

  return (
    <div
      ref={listRef}
      role="tree"
      aria-label="Property structure"
      className="h-full overflow-y-auto text-sm"
      onKeyDown={onKeyDown}
    >
      {visible.map((node) => {
        const isExpandable = node.children.length > 0;
        const isExpanded = expanded.has(node.id);
        const isSelected = !!(
          selection &&
          node.selection?.kind === selection.kind &&
          node.selection.id === selection.id
        );
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-label={node.label}
            aria-describedby={node.secondary ? `property-description-${encodeURIComponent(node.id)}` : undefined}
            aria-level={node.depth + 1}
            aria-expanded={isExpandable ? isExpanded : undefined}
            aria-selected={isSelected}
            data-node={node.id}
            tabIndex={focusId === node.id ? 0 : -1}
            onFocus={() => setFocusId(node.id)}
            onClick={() => {
              setFocusId(node.id);
              activate(node);
            }}
            style={{ paddingLeft: `${node.depth * 9 + 5}px` }}
            className={`flex min-h-7 cursor-default items-center gap-1 rounded pr-1.5 text-[13px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
              isSelected ? "bg-accent-soft text-accent-text" : "hover:bg-surface-3"
            }`}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label={isExpandable ? `${isExpanded ? "Collapse" : "Expand"} ${node.label}` : undefined}
              disabled={!isExpandable}
              className="w-3 shrink-0 text-xs text-ink-3 disabled:pointer-events-none"
              onClick={(event) => {
                if (!isExpandable) return;
                event.stopPropagation();
                toggle(node.id);
              }}
            >
              {isExpandable ? (isExpanded ? "−" : "+") : ""}
            </button>
            <span className="truncate">{node.label}</span>
            {node.secondary ? (
              <span id={`property-description-${encodeURIComponent(node.id)}`} className="truncate text-[11px] text-ink-3">{node.secondary}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
