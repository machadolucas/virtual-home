"use client";
/**
 * The non-3D route to everything: property → buildings → floors → rooms → surfaces, plus the
 * equipment placed on each floor.
 *
 * `role="tree"` with a **roving `tabIndex`**: one tab stop for the whole tree, arrows navigate,
 * `Home`/`End` jump, `Enter`/`Space` selects, typing jumps to a matching label. Selecting here
 * writes the store, and the canvas highlight follows — so a keyboard-only user can isolate a
 * floor, select a room and read the inspector without touching the 3D view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Selection } from "@/house/model/types";
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

export function PropertyTree() {
  const runtime = useHouseRuntime();
  const { index, placements, selection } = useHouseStore(
    useShallow((s) => ({ index: s.index, placements: s.placements, selection: s.selection })),
  );
  const isolateFloor = useHouseStore((s) => s.isolateFloor);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["property"]));
  const [focusId, setFocusId] = useState<string>("property");
  const typeahead = useRef({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => {
    const map = new Map<string, TreeNode>();
    if (!index) return map;

    const add = (node: TreeNode) => map.set(node.id, node);

    add({
      id: "property",
      label: index.manifest.name ?? index.modelId,
      depth: 0,
      selection: null,
      children: [],
      parent: null,
    });

    for (const building of index.buildings.values()) {
      const bid = `building:${building.id}`;
      map.get("property")!.children.push(bid);
      add({
        id: bid,
        label: building.name,
        secondary: building.placementStatus === "verified" ? undefined : `placement ${building.placementStatus}`,
        depth: 1,
        selection: { kind: "building", id: building.id },
        children: [],
        parent: "property",
      });

      for (const floor of index.floorsByBuilding.get(building.id) ?? []) {
        const fid = `floor:${floor.id}`;
        map.get(bid)!.children.push(fid);
        add({
          id: fid,
          label: floor.name,
          secondary: floor.nameFi ?? undefined,
          depth: 2,
          selection: { kind: "floor", id: floor.id },
          children: [],
          parent: bid,
          floorId: floor.id,
        });

        for (const room of index.roomsByFloor.get(floor.id) ?? []) {
          const rid = `room:${room.id}`;
          map.get(fid)!.children.push(rid);
          add({
            id: rid,
            label: room.name,
            secondary: [room.nameFi, room.kind && room.kind !== "room" ? room.kind : null]
              .filter(Boolean)
              .join(" · ") || undefined,
            depth: 3,
            selection: { kind: "room", id: room.id },
            children: [],
            parent: fid,
            floorId: floor.id,
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
              depth: 4,
              selection: { kind: "surface", id: surfaceId },
              children: [],
              parent: rid,
              floorId: floor.id,
            });
          }
        }

        for (const placement of placements.filter((p) => p.floorId === floor.id)) {
          const pid = `equipment:${placement.id}`;
          map.get(fid)!.children.push(pid);
          add({
            id: pid,
            label: placement.name,
            secondary: placement.roomId ?? undefined,
            depth: 3,
            selection: { kind: "equipment", id: placement.id },
            children: [],
            parent: fid,
            floorId: floor.id,
          });
        }
      }
    }
    return map;
  }, [index, placements]);

  const visible = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (id: string) => {
      const node = nodes.get(id);
      if (!node) return;
      out.push(node);
      if (!expanded.has(id)) return;
      for (const child of node.children) walk(child);
    };
    if (nodes.has("property")) walk("property");
    return out;
  }, [nodes, expanded]);

  const selectedId = useMemo(() => {
    if (!selection) return null;
    return `${selection.kind}:${selection.id}`;
  }, [selection]);

  const activate = useCallback(
    (node: TreeNode) => {
      if (node.selection?.kind === "floor" && node.floorId) isolateFloor(node.floorId);
      runtime.select(node.selection, { frame: node.selection?.kind === "room" });
    },
    [runtime, isolateFloor],
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
              if (isExpandable) toggle(node.id);
              activate(node);
            }}
            style={{ paddingLeft: `${node.depth * 12 + 8}px` }}
            className={`flex min-h-8 cursor-default items-center gap-1.5 rounded pr-2 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              isSelected ? "bg-sky-50 text-sky-900" : "hover:bg-neutral-100"
            }`}
          >
            <span aria-hidden="true" className="w-3 shrink-0 text-neutral-400">
              {isExpandable ? (isExpanded ? "−" : "+") : ""}
            </span>
            <span className="truncate">{node.label}</span>
            {node.secondary ? (
              <span className="truncate text-xs text-neutral-500">{node.secondary}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
