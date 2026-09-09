/** Reserve shader inputs for daylight and the model's normal, colour and texture coordinates. */
export function detailedLightHardwareLimit(maxTextures: number, maxVaryings: number, materialTextures = 3): number {
  return Math.max(0, Math.min(64, Math.floor(maxTextures) - 1 - Math.max(3, materialTextures), Math.floor(maxVaryings) - 6));
}

/** Allocate a total budget using installed fixtures, including off lights, so HA events do not
 * change shader layouts. Spare slots go to the kind that can use them. */
export function detailedLightBudget(limit: number, pointCount: number, spotCount: number): { point: number; spot: number } {
  const total = Number.isFinite(limit) ? Math.max(0, Math.min(64, Math.floor(limit))) : 0;
  let point = Math.min(pointCount, Math.ceil(total / 2));
  let spot = Math.min(spotCount, total - point);
  point = Math.min(pointCount, total - spot);
  spot = Math.min(spotCount, total - point);
  return { point, spot };
}
