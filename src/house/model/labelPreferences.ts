export interface HouseLabelPreferences {
  /** Resolved names: explicit household name, confirmed HA mapping, then app location. */
  names: Record<string, string>;
  /** Resolved per-node visibility. Missing means visible. */
  visibility: Record<string, boolean>;
  /** Explicit overrides only, used to distinguish reset from a resolved fallback. */
  customNames: Record<string, string>;
  customVisibility: Record<string, boolean>;
}

export const EMPTY_LABEL_PREFERENCES: HouseLabelPreferences = {
  names: {},
  visibility: {},
  customNames: {},
  customVisibility: {},
};

export function displayNameForNode(
  nodeId: string,
  fallback: string,
  preferences: HouseLabelPreferences,
): string {
  const preferred = preferences.names[nodeId]?.trim();
  return preferred || fallback;
}

export function labelVisibleForNode(
  nodeId: string,
  preferences: HouseLabelPreferences,
  defaultVisible = true,
): boolean {
  return preferences.visibility[nodeId] ?? defaultVisible;
}

/**
 * Infer a display-only floor name when every confirmed room→HA-area mapping on that app floor
 * points at the same HA floor. This never creates or changes a mapping; disagreement stays honest.
 */
export function inferFloorDisplayNames(
  areas: readonly { floorNodeId: string; haFloorId: string }[],
  haFloorNames: ReadonlyMap<string, string>,
  directlyMappedFloorNodeIds: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const idsByFloor = new Map<string, Set<string>>();
  for (const area of areas) {
    const ids = idsByFloor.get(area.floorNodeId) ?? new Set<string>();
    ids.add(area.haFloorId);
    idsByFloor.set(area.floorNodeId, ids);
  }
  const names: Record<string, string> = {};
  for (const [floorNodeId, ids] of idsByFloor) {
    if (directlyMappedFloorNodeIds.has(floorNodeId) || ids.size !== 1) continue;
    const id = [...ids][0];
    const name = id ? haFloorNames.get(id) : undefined;
    if (name) names[floorNodeId] = name;
  }
  return names;
}

export function defaultRoomLabelVisibility(
  rooms: readonly { id: string; kind?: string | null }[],
): Record<string, boolean> {
  const visibility: Record<string, boolean> = {};
  for (const room of rooms)
    if (room.kind === "attic" || room.kind === "void") visibility[room.id] = false;
  return visibility;
}
