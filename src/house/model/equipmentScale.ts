import type { Placement, Vec3 } from "./types";
import { isLedBar, ledLength } from "./equipmentOptics";
import { DEFAULT_WOOD_STORAGE_SIZE } from "./equipmentSize";
import { DEFAULT_SOLAR_PANEL_CONFIG } from "./solarPanel";
import { treeScale } from "./tree";

/** Per-instance scale over a symbol's authored/default physical envelope. */
export function equipmentSymbolScale(
  placement: Partial<Placement>,
): Vec3 {
  if (placement.symbol === "solar_panel") {
    const panel = placement.solarPanel ?? DEFAULT_SOLAR_PANEL_CONFIG;
    return [panel.widthM, panel.thicknessM, panel.lengthM];
  }
  if (isLedBar(placement.symbol)) {
    const length = ledLength(placement.ledLengthM);
    return placement.symbol === "led_bar_horizontal" ? [length, 1, 1] : [1, length, 1];
  }
  if (placement.symbol === "tree") {
    const scale = treeScale(placement.treeHeightM);
    return [scale, scale, scale];
  }
  if (placement.symbol === "outdoor_wood_storage") {
    const size = placement.equipmentSize ?? DEFAULT_WOOD_STORAGE_SIZE;
    return [
      size.widthM / DEFAULT_WOOD_STORAGE_SIZE.widthM,
      size.heightM / DEFAULT_WOOD_STORAGE_SIZE.heightM,
      size.depthM / DEFAULT_WOOD_STORAGE_SIZE.depthM,
    ];
  }
  return [1, 1, 1];
}
