/**
 * Cross-reference checks over a parsed manifest.
 *
 * These return diagnostics instead of throwing, so a partially broken package still yields a
 * useful setup state (the user sees *which* id is dangling, not a blank canvas). Error codes
 * block interactive use; warning codes are informational.
 */
import type { Manifest, Surface } from "./types";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  ids?: string[];
}

const ASSET_PATH_RE = /^assets\/[A-Za-z0-9._-]+\.glb$/;

function idSet(items: ReadonlyArray<{ id: string }>): Set<string> {
  return new Set(items.map((i) => i.id));
}

/** Room-facing surface kinds. Filtering by `kind` alone is exactly correct (see model-contract). */
const ROOM_KINDS = new Set<Surface["kind"]>(["floor", "wall", "ceiling"]);

export function crossCheck(m: Manifest): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, ids?: string[]) =>
    out.push({ severity: "error", code, message, ids });
  const warn = (code: string, message: string, ids?: string[]) =>
    out.push({ severity: "warning", code, message, ids });
  const info = (code: string, message: string, ids?: string[]) =>
    out.push({ severity: "info", code, message, ids });

  const buildings = idSet(m.buildings);
  const floors = idSet(m.floors);
  const rooms = idSet(m.rooms);
  const assets = idSet(m.assets);
  const elements = idSet(m.elements);
  const surfaces = idSet(m.surfaces);

  const floorById = new Map(m.floors.map((f) => [f.id, f]));

  // ---- duplicate ids -------------------------------------------------------
  for (const [label, list] of [
    ["buildings", m.buildings],
    ["floors", m.floors],
    ["rooms", m.rooms],
    ["assets", m.assets],
    ["elements", m.elements],
    ["surfaces", m.surfaces],
  ] as const) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const item of list) {
      if (seen.has(item.id)) dupes.push(item.id);
      seen.add(item.id);
    }
    if (dupes.length) err("E_DUPLICATE_ID", `duplicate ids in ${label}`, dupes);
  }

  // ---- errors --------------------------------------------------------------
  for (const f of m.floors) {
    if (!buildings.has(f.buildingId))
      err("E_FLOOR_BUILDING", `floor ${f.id} references unknown building ${f.buildingId}`, [f.id]);
  }

  for (const r of m.rooms) {
    const f = floorById.get(r.floorId);
    if (!f) {
      err("E_ROOM_FLOOR", `room ${r.id} references unknown floor ${r.floorId}`, [r.id]);
    } else if (r.buildingId && r.buildingId !== f.buildingId) {
      err(
        "E_ROOM_FLOOR",
        `room ${r.id} claims building ${r.buildingId} but its floor ${f.id} is in ${f.buildingId}`,
        [r.id],
      );
    }
    for (const sid of r.surfaceIds) {
      if (!surfaces.has(sid))
        err("E_ROOM_SURFACE", `room ${r.id} lists unknown surface ${sid}`, [r.id, sid]);
    }
  }

  for (const a of m.assets) {
    if (!ASSET_PATH_RE.test(a.path))
      err("E_ASSET_PATH", `asset ${a.id} has an unsafe or non-glb path ${a.path}`, [a.id]);
    if (a.buildingId && !buildings.has(a.buildingId))
      err("E_ASSET_PATH", `asset ${a.id} references unknown building ${a.buildingId}`, [a.id]);
    if (a.floorId && !floors.has(a.floorId))
      err("E_ASSET_PATH", `asset ${a.id} references unknown floor ${a.floorId}`, [a.id]);
  }

  for (const f of m.floors) {
    for (const aid of [...f.assetIds, ...f.scanAssetIds]) {
      if (!assets.has(aid))
        err("E_FLOOR_ASSET", `floor ${f.id} references unknown asset ${aid}`, [f.id, aid]);
    }
  }

  for (const b of m.buildings) {
    for (const fid of b.floorIds)
      if (!floors.has(fid))
        err("E_FLOOR_BUILDING", `building ${b.id} lists unknown floor ${fid}`, [b.id, fid]);
    for (const aid of b.assetIds)
      if (!assets.has(aid))
        err("E_FLOOR_ASSET", `building ${b.id} lists unknown asset ${aid}`, [b.id, aid]);
  }

  // node-ref uniqueness across ALL surfaces AND elements' own group nodes
  const nodeOwner = new Map<string, string>();
  const dupNodes: string[] = [];
  for (const s of m.surfaces) {
    for (const nr of s.nodeRefs) {
      if (!assets.has(nr.assetId))
        err("E_NODEREF_ASSET", `surface ${s.id} references unknown asset ${nr.assetId}`, [s.id]);
      const key = `${nr.assetId}/${nr.nodeName}`;
      const prev = nodeOwner.get(key);
      if (prev && prev !== s.id) dupNodes.push(`${key} (${prev} vs ${s.id})`);
      else nodeOwner.set(key, s.id);
    }
    if (s.roomId && !rooms.has(s.roomId))
      err("E_SURFACE_ROOM", `surface ${s.id} references unknown room ${s.roomId}`, [s.id]);
    if (s.elementId && !elements.has(s.elementId))
      err("E_SURFACE_ELEMENT", `surface ${s.id} references unknown element ${s.elementId}`, [s.id]);
  }
  for (const e of m.elements) {
    for (const nr of e.nodeRefs) {
      if (!assets.has(nr.assetId))
        err("E_NODEREF_ASSET", `element ${e.id} references unknown asset ${nr.assetId}`, [e.id]);
    }
    // `nodeRefs[0]` is the element's own group node; the rest are its surfaces (contract v1.0).
    const own = e.nodeRefs[0];
    if (own) {
      const key = `${own.assetId}/${own.nodeName}`;
      const prev = nodeOwner.get(key);
      if (prev && prev !== e.id) dupNodes.push(`${key} (${prev} vs ${e.id})`);
      else nodeOwner.set(key, e.id);
    }
    for (const sid of e.surfaceIds)
      if (!surfaces.has(sid))
        err("E_ELEMENT_SURFACE", `element ${e.id} lists unknown surface ${sid}`, [e.id, sid]);
    if (e.floorId && !floors.has(e.floorId))
      err("E_ELEMENT_SURFACE", `element ${e.id} references unknown floor ${e.floorId}`, [e.id]);
    for (const rid of e.roomIds ?? [])
      if (!rooms.has(rid))
        err("E_ELEMENT_SURFACE", `element ${e.id} references unknown room ${rid}`, [e.id, rid]);
  }
  if (dupNodes.length)
    err("E_NODEREF_DUP", "the same (assetId, nodeName) is claimed twice", dupNodes);

  for (let i = 0; i < 3; i++) {
    const lo = m.bounds.min[i] as number;
    const hi = m.bounds.max[i] as number;
    if (!(lo < hi)) err("E_BOUNDS", `bounds.min[${i}] must be below bounds.max[${i}]`);
  }

  for (const iss of m.issues) {
    for (const id of iss.affects) {
      if (
        !buildings.has(id) &&
        !floors.has(id) &&
        !rooms.has(id) &&
        !assets.has(id) &&
        !elements.has(id) &&
        !surfaces.has(id)
      )
        warn("W_ISSUE_AFFECTS", `issue ${iss.id} affects unknown id ${id}`, [iss.id, id]);
    }
  }

  // ---- warnings ------------------------------------------------------------
  const surfaceById = new Map(m.surfaces.map((s) => [s.id, s]));
  const byRoomKind = new Map<string, Set<Surface["kind"]>>();
  for (const s of m.surfaces) {
    if (!s.roomId) continue;
    let set = byRoomKind.get(s.roomId);
    if (!set) byRoomKind.set(s.roomId, (set = new Set()));
    set.add(s.kind);
  }
  for (const r of m.rooms) {
    const kinds = byRoomKind.get(r.id) ?? new Set<Surface["kind"]>();
    if (!kinds.has("floor")) {
      // A stair well (`kind: 'void'`) legitimately has a footprint but no floor face.
      if (r.kind === "void")
        info("W_ROOM_NO_FLOOR_SURF", `room ${r.id} (void) has no floor surface — expected`, [r.id]);
      else warn("W_ROOM_NO_FLOOR_SURF", `room ${r.id} has no floor surface`, [r.id]);
    }
    if (!kinds.has("ceiling")) warn("W_ROOM_NO_CEILING", `room ${r.id} has no ceiling surface`, [r.id]);
    const listed = new Set(r.surfaceIds);
    for (const sid of r.surfaceIds) {
      const s = surfaceById.get(sid);
      if (s && s.roomId && s.roomId !== r.id)
        warn(
          "W_ORPHAN_SURFACE",
          `room ${r.id} lists surface ${sid}, which belongs to room ${s.roomId}`,
          [r.id, sid],
        );
    }
    for (const s of m.surfaces) {
      if (s.roomId === r.id && ROOM_KINDS.has(s.kind) && !listed.has(s.id))
        warn(
          "W_ORPHAN_SURFACE",
          `surface ${s.id} claims room ${r.id} but is not in that room's surfaceIds`,
          [r.id, s.id],
        );
    }
  }

  const referencedAssets = new Set<string>();
  for (const s of m.surfaces) for (const nr of s.nodeRefs) referencedAssets.add(nr.assetId);
  for (const e of m.elements) for (const nr of e.nodeRefs) referencedAssets.add(nr.assetId);
  for (const a of m.assets) {
    if (!referencedAssets.has(a.id))
      warn("W_ASSET_UNREFERENCED", `asset ${a.id} is referenced by no surface or element`, [a.id]);
  }

  return out;
}

export const hasErrors = (d: readonly Diagnostic[]): boolean => d.some((x) => x.severity === "error");
export const errorsOf = (d: readonly Diagnostic[]): Diagnostic[] =>
  d.filter((x) => x.severity === "error");
