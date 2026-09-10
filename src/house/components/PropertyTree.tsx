"use client";
/**
 * The non-3D route to everything: buildings → floors → rooms → surfaces, plus the
 * equipment placed on each floor and an `Outside` branch for the outdoor zones and anything
 * placed out there.
 *
 * `role="tree"` with a **roving `tabIndex`**: one tab stop for the whole tree, arrows navigate,
 * `Home`/`End` jump, `Enter`/`Space` selects, typing jumps to a matching label. Selecting here
 * writes the store, and the canvas highlight follows — so a keyboard-only user can isolate a
 * floor, select a room and read the inspector without touching the 3D view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Selection } from "@/house/model/types";
import { displayNameForNode } from "@/house/model/labelPreferences";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";

interface TreeNode {
  id: string;
  label: string;
  secondary?: string;
  depth: number;
  selection: Selection | null;
  children: string[];
  parent: string | null;
  /** Floor nodes also isolate the floor when selected. */
  floorId?: string;
}

/**
 * The outdoor zones, by the element `kind` the package uses. Mirrors
 * `OUTDOOR_ZONE_ELEMENTS` in `src/server/house-model/revision.ts` — the same three zones the
 * importer mirrors into the `location` tree, so "Yard" means the same thing in both places.
 */
const OUTDOOR_ZONES = [
  { kind: "terrain", name: "Yard" },
  { kind: "terrace", name: "Terrace" },
  { kind: "balcony", name: "Balcony" },
] as const;

export function PropertyTree() {
  const runtime = useHouseRuntime();
  const { index, placements, selection, labelPreferences } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      placements: s.placements,
      selection: s.selection,
      labelPreferences: s.labelPreferences,
    })),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string>("");
  const initialisedModel = useRef<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => {
    const map = new Map<string, TreeNode>();
    if (!index) return map;

    const add = (node: TreeNode) => map.set(node.id, node);

    const addFloorContents = (parentId: string, floorId: string, depth: number) => {
      for (const room of index.roomsByFloor.get(floorId) ?? []) {
        const rid = `room:${room.id}`;
        map.get(parentId)!.children.push(rid);
        add({
          id: rid,
          label: displayNameForNode(room.id, room.name, labelPreferences),
          secondary: [displayNameForNode(room.id, room.name, labelPreferences) === room.name ? room.nameFi : null, room.kind && room.kind !== "room" ? room.kind : null]
            .filter(Boolean)
            .join(" · ") || undefined,
          depth,
          selection: { kind: "room", id: room.id },
          children: [],
          parent: parentId,
          floorId,
        });

        for (const surfaceId of index.roomSurfaces.get(room.id) ?? []) {
          const surface = index.surfaces.get(surfaceId);
          if (!surface) continue;
          const sid = `surface:${surfaceId}`;
          map.get(rid)!.children.push(sid);
          add({
            id: sid,
            label: `${surface.kind}${surface.role ? ` · ${surface.role}` : ""}`,
            secondary: surfaceId,
            depth: depth + 1,
            selection: { kind: "surface", id: surfaceId },
            children: [],
            parent: rid,
            floorId,
          });
        }
      }

      for (const placement of placements.filter((p) => p.floorId === floorId && p.roomId)) {
        const pid = `equipment:${placement.id}`;
        map.get(parentId)!.children.push(pid);
        add({
          id: pid,
          label: placement.name,
          secondary: placement.roomId ?? undefined,
          depth,
          selection: { kind: "equipment", id: placement.id },
          children: [],
          parent: parentId,
          floorId,
        });
      }
    };

    for (const building of index.buildings.values()) {
      const floors = index.floorsByBuilding.get(building.id) ?? [];
      const bid = `building:${building.id}`;

      // A one-storey building does not need both "Garage" and "Garage floor" rows. Keep the
      // floor's semantic id and focus behaviour, but present it using the useful building name.
      if (floors.length === 1) {
        const floor = floors[0]!;
        const fid = `floor:${floor.id}`;
        add({
          id: fid,
          label: displayNameForNode(building.id, building.name, labelPreferences),
          secondary: building.placementStatus === "verified" ? undefined : `placement ${building.placementStatus}`,
          depth: 0,
          selection: { kind: "floor", id: floor.id },
          children: [],
          parent: null,
          floorId: floor.id,
        });
        addFloorContents(fid, floor.id, 1);
        continue;
      }

      add({
        id: bid,
        label: displayNameForNode(building.id, building.name, labelPreferences),
        secondary: building.placementStatus === "verified" ? undefined : `placement ${building.placementStatus}`,
        depth: 0,
        selection: { kind: "building", id: building.id },
        children: [],
        parent: null,
      });

      for (const floor of floors) {
        const fid = `floor:${floor.id}`;
        map.get(bid)!.children.push(fid);
        add({
          id: fid,
          label: displayNameForNode(floor.id, floor.name, labelPreferences),
          secondary: displayNameForNode(floor.id, floor.name, labelPreferences) === floor.name ? floor.nameFi ?? undefined : undefined,
          depth: 1,
          selection: { kind: "floor", id: floor.id },
          children: [],
          parent: bid,
          floorId: floor.id,
        });

        addFloorContents(fid, floor.id, 2);
      }
    }

    // Outside. The package's `rooms` are interior only, so anything on the terrace, the balcony or
    // in the yard resolves to no room and would otherwise be invisible here — including the yard
    // lamps and eave fixtures this branch exists to reach. The zones mirror the same element kinds
    // the importer turns into `location` rows (`OUTDOOR_ZONE_ELEMENTS`), so the two trees agree.
    const outdoorPlacements = placements.filter((p) => !p.roomId);
    const zones = OUTDOOR_ZONES.map((zone) => {
      const element = [...index.elements.values()].find((e) => e.kind === zone.kind);
      return element ? { ...zone, elementId: element.id } : null;
    }).filter((zone): zone is (typeof OUTDOOR_ZONES)[number] & { elementId: string } => zone !== null);

    if (zones.length > 0 || outdoorPlacements.length > 0) {
      add({
        id: "outside",
        label: "Outside",
        secondary: outdoorPlacements.length > 0 ? `${outdoorPlacements.length} placed` : undefined,
        depth: 0,
        selection: null,
        children: [],
        parent: null,
      });

      for (const zone of zones) {
        const zid = `element:${zone.elementId}`;
        map.get("outside")!.children.push(zid);
        add({
          id: zid,
          label: zone.name,
          secondary: zone.elementId,
          depth: 1,
          selection: { kind: "element", id: zone.elementId },
          children: [],
          parent: "outside",
        });
      }

      for (const placement of outdoorPlacements) {
        const pid = `equipment:${placement.id}`;
        map.get("outside")!.children.push(pid);
        add({
          id: pid,
          label: placement.name,
          secondary: "outside",
          depth: 1,
          selection: { kind: "equipment", id: placement.id },
          children: [],
          parent: "outside",
          floorId: placement.floorId,
        });
      }
    }

    return map;
  }, [index, placements, labelPreferences]);

  const visible = useMemo(() => {
    const out: TreeNode[] = [];
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
      new Set(
        [...nodes.values()]
          .filter((node) => node.children.length > 0 && node.depth <= 1)
          .map((node) => node.id),
      ),
    );
    setFocusId([...nodes.values()].find((node) => node.parent === null)?.id ?? "");
  }, [index, nodes]);

  const selectedId = useMemo(() => {
    if (!selection) return null;
    return `${selection.kind}:${selection.id}`;
  }, [selection]);

  const activate = useCallback(
    (node: TreeNode) => {
      const state = runtime.store.getState();
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
      if (node.floorId && state.activeFloorId !== node.floorId) state.isolateFloor(node.floorId);
      runtime.select(node.selection, { frame: node.selection !== null });
    },
    [runtime],
  );

  const toggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

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
        const isSelected = selectedId === node.id;
        return (
          <div
            key={node.id}
            role="treeitem"
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
              <span className="truncate text-[11px] text-ink-3">{node.secondary}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
