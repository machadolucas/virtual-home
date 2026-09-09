import type { ManifestIndex } from "./manifestIndex";

/** Package underside naming is a fallback for older packages without a semantic role. */
export function isSoffitSurface(surfaceId: string, kind: string | undefined): boolean {
  return kind === "ceiling" || (kind === "other" &&
    (/(^|-)(soffit|eave)(-|$)/.test(surfaceId) || /-under$/.test(surfaceId)));
}

/** Shared by the picker, numeric editor and authenticated write validation. */
export function canMountSurface(index: ManifestIndex, surfaceId: string, mount: "wall" | "ceiling"): boolean {
  const surface = index.surfaces.get(surfaceId);
  if (!surface) return false;
  if (mount === "ceiling") {
    return isSoffitSurface(surfaceId, surface.kind) ||
      (surface.kind === "other" && ["soffit", "eave", "roof-underside"].includes(surface.role ?? ""));
  }
  if (surface.kind === "wall") return true;
  const element = surface.elementId ? index.elements.get(surface.elementId) : undefined;
  return surface.kind === "other" && surface.role === "exterior" && element?.kind === "exterior-wall";
}

/** Free attachment may reference any physical package surface, never a scan overlay. */
export function canAttachSurface(index: ManifestIndex, surfaceId: string): boolean {
  const surface = index.surfaces.get(surfaceId);
  if (!surface) return false;
  const element = surface.elementId ? index.elements.get(surface.elementId) : undefined;
  return surface.role !== "scan" && element?.kind !== "scan-reference";
}
