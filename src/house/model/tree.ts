/** Physical height of the procedural tree silhouette, in site metres. */
export const DEFAULT_TREE_HEIGHT_M = 5;
export const MIN_TREE_HEIGHT_M = 0.5;
export const MAX_TREE_HEIGHT_M = 30;

export function treeHeight(value: number | null | undefined): number {
  return Number.isFinite(value) && value! >= MIN_TREE_HEIGHT_M && value! <= MAX_TREE_HEIGHT_M
    ? value!
    : DEFAULT_TREE_HEIGHT_M;
}

/** Trees grow proportionally; the authored silhouette is five metres tall. */
export function treeScale(value: number | null | undefined): number {
  return treeHeight(value) / DEFAULT_TREE_HEIGHT_M;
}
