import type { HouseLabelPreferences } from "./labelPreferences";
import { displayNameForNode } from "./labelPreferences";
import type { ManifestIndex } from "./manifestIndex";
import { routePointPlace } from "./routePlaces";
import type { Furnishing, Placement, Route, RouteKind, Selection } from "./types";

export type PropertyTreeNodeKind =
  | "building"
  | "floor"
  | "section"
  | "room"
  | "surface"
  | "equipment"
  | "route-group"
  | "route"
  | "furnishing"
  | "outside"
  | "element";

export interface PropertyTreeNode {
  id: string;
  label: string;
  secondary?: string;
  depth: number;
  kind: PropertyTreeNodeKind;
  selection: Selection | null;
  furnishingId?: string;
  children: string[];
  parent: string | null;
  floorId?: string;
}

export interface PropertyTreeInput {
  index: ManifestIndex;
  placements: readonly Placement[];
  routes: readonly Route[];
  furnishings: readonly Furnishing[];
  labelPreferences: HouseLabelPreferences;
}

export function routeFloorIds(route: Route): Set<string> {
  const floorIds = new Set<string>();
  for (let index = 0; index < route.points.length; index += 1) {
    const floorId = routePointPlace(route, index).floorId;
    if (floorId) floorIds.add(floorId);
  }
  return floorIds;
}

export const ROUTE_KIND_LABEL: Readonly<Record<RouteKind, string>> = {
  pipe: "Pipes",
  duct: "Ducts",
  cable: "Cables",
  valve: "Valves",
  outlet: "Outlets",
  switch: "Switches",
  junction: "Junctions",
  "access-point": "Access points",
  other: "Other",
};

export const ROUTE_KIND_ORDER: readonly RouteKind[] = [
  "pipe",
  "duct",
  "cable",
  "valve",
  "outlet",
  "switch",
  "junction",
  "access-point",
  "other",
];

const OUTDOOR_ZONES = [
  { kind: "terrain", name: "Yard" },
  { kind: "terrace", name: "Terrace" },
  { kind: "balcony", name: "Balcony" },
] as const;

/** Build the semantic navigation tree independently of React's expanded/focused row state. */
export function buildPropertyTree({
  index,
  placements,
  routes,
  furnishings,
  labelPreferences,
}: PropertyTreeInput): Map<string, PropertyTreeNode> {
  const map = new Map<string, PropertyTreeNode>();
  const add = (node: PropertyTreeNode) => map.set(node.id, node);
  const append = (parentId: string, node: PropertyTreeNode) => {
    map.get(parentId)!.children.push(node.id);
    add(node);
  };

  const addFloorContents = (parentId: string, floorId: string, depth: number) => {
    const roomsId = `section:${floorId}:rooms`;
    append(parentId, section(roomsId, "Rooms", depth, parentId, floorId));
    for (const room of index.roomsByFloor.get(floorId) ?? []) {
      const rid = `room:${room.id}`;
      const roomLabel = displayNameForNode(room.id, room.name, labelPreferences);
      append(roomsId, {
        id: rid,
        label: roomLabel,
        secondary: [roomLabel === room.name ? room.nameFi : null, room.kind && room.kind !== "room" ? room.kind : null]
          .filter(Boolean)
          .join(" · ") || undefined,
        depth: depth + 1,
        kind: "room",
        selection: { kind: "room", id: room.id },
        children: [],
        parent: roomsId,
        floorId,
      });
      for (const surfaceId of index.roomSurfaces.get(room.id) ?? []) {
        const surface = index.surfaces.get(surfaceId);
        if (!surface) continue;
        append(rid, {
          id: `surface:${surfaceId}`,
          label: `${surface.kind}${surface.role ? ` · ${surface.role}` : ""}`,
          secondary: surfaceId,
          depth: depth + 2,
          kind: "surface",
          selection: { kind: "surface", id: surfaceId },
          children: [],
          parent: rid,
          floorId,
        });
      }
    }

    const equipmentId = `section:${floorId}:equipment`;
    append(parentId, section(equipmentId, "Equipment", depth, parentId, floorId));
    for (const placement of placements.filter((item) => item.floorId === floorId && item.roomId)) {
      append(equipmentId, {
        id: `equipment:${placement.id}`,
        label: placement.name,
        secondary: locationName(index, placement.roomId, labelPreferences),
        depth: depth + 1,
        kind: "equipment",
        selection: { kind: "equipment", id: placement.id },
        children: [],
        parent: equipmentId,
        floorId,
      });
    }

    const infrastructureId = `section:${floorId}:infrastructure`;
    append(parentId, section(infrastructureId, "Infrastructure", depth, parentId, floorId));
    const floorRoutes = routes.filter((route) => routeFloorIds(route).has(floorId));
    for (const routeKind of ROUTE_KIND_ORDER) {
      const matching = floorRoutes.filter((route) => route.kind === routeKind);
      if (matching.length === 0) continue;
      const groupId = `route-group:${floorId}:${routeKind}`;
      append(infrastructureId, {
        id: groupId,
        label: ROUTE_KIND_LABEL[routeKind],
        depth: depth + 1,
        kind: "route-group",
        selection: null,
        children: [],
        parent: infrastructureId,
        floorId,
      });
      for (const route of matching) {
        append(groupId, {
          id: `route:${floorId}:${route.id}`,
          label: route.name,
          secondary: route.system,
          depth: depth + 2,
          kind: "route",
          selection: { kind: "route", id: route.id },
          children: [],
          parent: groupId,
          floorId,
        });
      }
    }

    const furnitureId = `section:${floorId}:furniture`;
    append(parentId, section(furnitureId, "Furniture", depth, parentId, floorId));
    for (const item of furnishings.filter((furnishing) => furnishing.floorId === floorId)) {
      append(furnitureId, {
        id: `furnishing:${item.id}`,
        label: item.name,
        secondary: locationName(index, item.roomId, labelPreferences),
        depth: depth + 1,
        kind: "furnishing",
        selection: null,
        furnishingId: item.id,
        children: [],
        parent: furnitureId,
        floorId,
      });
    }
  };

  for (const building of index.buildings.values()) {
    const floors = index.floorsByBuilding.get(building.id) ?? [];
    const secondary = building.placementStatus === "verified" ? undefined : `placement ${building.placementStatus}`;
    if (floors.length === 1) {
      const floor = floors[0]!;
      const fid = `floor:${floor.id}`;
      add({
        id: fid,
        label: displayNameForNode(building.id, building.name, labelPreferences),
        secondary,
        depth: 0,
        kind: "floor",
        selection: { kind: "floor", id: floor.id },
        children: [],
        parent: null,
        floorId: floor.id,
      });
      addFloorContents(fid, floor.id, 1);
      continue;
    }

    const bid = `building:${building.id}`;
    add({
      id: bid,
      label: displayNameForNode(building.id, building.name, labelPreferences),
      secondary,
      depth: 0,
      kind: "building",
      selection: { kind: "building", id: building.id },
      children: [],
      parent: null,
    });
    for (const floor of floors) {
      const fid = `floor:${floor.id}`;
      const floorLabel = displayNameForNode(floor.id, floor.name, labelPreferences);
      append(bid, {
        id: fid,
        label: floorLabel,
        secondary: floorLabel === floor.name ? floor.nameFi ?? undefined : undefined,
        depth: 1,
        kind: "floor",
        selection: { kind: "floor", id: floor.id },
        children: [],
        parent: bid,
        floorId: floor.id,
      });
      addFloorContents(fid, floor.id, 2);
    }
  }

  const outdoorPlacements = placements.filter((placement) => !placement.roomId);
  const zones = OUTDOOR_ZONES.map((zone) => {
    const element = [...index.elements.values()].find((candidate) => candidate.kind === zone.kind);
    return element ? { ...zone, elementId: element.id } : null;
  }).filter((zone): zone is (typeof OUTDOOR_ZONES)[number] & { elementId: string } => zone !== null);

  if (zones.length > 0 || outdoorPlacements.length > 0) {
    add({
      id: "outside",
      label: "Outside",
      secondary: outdoorPlacements.length > 0 ? `${outdoorPlacements.length} placed` : undefined,
      depth: 0,
      kind: "outside",
      selection: null,
      children: [],
      parent: null,
    });
    for (const zone of zones) {
      append("outside", {
        id: `element:${zone.elementId}`,
        label: zone.name,
        secondary: zone.elementId,
        depth: 1,
        kind: "element",
        selection: { kind: "element", id: zone.elementId },
        children: [],
        parent: "outside",
      });
    }
    for (const placement of outdoorPlacements) {
      append("outside", {
        id: `equipment:${placement.id}`,
        label: placement.name,
        secondary: "outside",
        depth: 1,
        kind: "equipment",
        selection: { kind: "equipment", id: placement.id },
        children: [],
        parent: "outside",
        floorId: placement.floorId,
      });
    }
  }

  const unassignedFurniture = furnishings.filter((item) => !index.floors.has(item.floorId));
  if (unassignedFurniture.length > 0) {
    const parentId = "section:unassigned-furniture";
    add({
      id: parentId,
      label: "Furniture needing a floor",
      secondary: `${unassignedFurniture.length}`,
      depth: 0,
      kind: "section",
      selection: null,
      children: [],
      parent: null,
    });
    for (const item of unassignedFurniture) {
      append(parentId, {
        id: `furnishing:${item.id}`,
        label: item.name,
        secondary: "Needs a floor",
        depth: 1,
        kind: "furnishing",
        selection: null,
        furnishingId: item.id,
        children: [],
        parent: parentId,
      });
    }
  }

  return map;
}

export function initiallyExpandedPropertyTreeNodes(nodes: ReadonlyMap<string, PropertyTreeNode>): Set<string> {
  return new Set(
    [...nodes.values()]
      .filter((node) =>
        node.children.length > 0 &&
        (node.kind === "building" || node.kind === "floor" || (node.kind === "section" && node.label === "Rooms")),
      )
      .map((node) => node.id),
  );
}

/** Keep the tree's single tab stop on a visible row after live data or expansion changes. */
export function repairedPropertyTreeFocus(
  nodes: ReadonlyMap<string, PropertyTreeNode>,
  previousNodes: ReadonlyMap<string, PropertyTreeNode>,
  visible: readonly PropertyTreeNode[],
  focusId: string,
): string {
  const visibleIds = new Set(visible.map((node) => node.id));
  if (visibleIds.has(focusId)) return focusId;

  let cursor = nodes.get(focusId) ?? previousNodes.get(focusId);
  const visited = new Set<string>();
  while (cursor?.parent && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (visibleIds.has(cursor.parent)) return cursor.parent;
    cursor = nodes.get(cursor.parent) ?? previousNodes.get(cursor.parent);
  }
  return visible[0]?.id ?? "";
}

function section(id: string, label: string, depth: number, parent: string, floorId: string): PropertyTreeNode {
  return { id, label, depth, kind: "section", selection: null, children: [], parent, floorId };
}

function locationName(
  index: ManifestIndex,
  roomId: string | null,
  preferences: HouseLabelPreferences,
): string | undefined {
  if (!roomId) return undefined;
  const room = index.rooms.get(roomId);
  return room ? displayNameForNode(room.id, room.name, preferences) : roomId;
}
