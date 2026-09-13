/** Physical height of the procedural tree silhouette, in site metres. */
export const DEFAULT_TREE_HEIGHT_M = 5;
export const MIN_TREE_HEIGHT_M = 0.5;
export const MAX_TREE_HEIGHT_M = 30;

export function treeHeight(value: number | null | undefined): number {
  return Number.isFinite(value) && value! >= MIN_TREE_HEIGHT_M && value! <= MAX_TREE_HEIGHT_M
    ? value!
    : DEFAULT_TREE_HEIGHT_M;
}

/** Vertical scale over the authored five-metre silhouette. */
export function treeScale(value: number | null | undefined): number {
  return treeHeight(value) / DEFAULT_TREE_HEIGHT_M;
}

/** Trunk diameter is symbolic, not a measurement inferred from tree height. */
export const AUTHORED_TREE_TRUNK_DIAMETER_M = 0.56;
export const MAX_TREE_TRUNK_DIAMETER_M = 0.6;
export function treeWidthScale(value: number | null | undefined): number {
  const scale = treeScale(value);
  return Math.min(scale, Math.sqrt(scale), MAX_TREE_TRUNK_DIAMETER_M / AUTHORED_TREE_TRUNK_DIAMETER_M);
}
