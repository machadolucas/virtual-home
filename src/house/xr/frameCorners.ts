import { ringSignedArea } from "../model/geometry2d";
import type { AlignmentModel } from "./roomAlignment";
import type { CalibrationFeature } from "./mixedCalibration";
import type { PanelPage } from "./panelLayout";

/** Upper corners of the modeled reveal, named as seen standing inside and facing the opening. */
export function frameCorners(model: AlignmentModel): CalibrationFeature[] {
  const winding = Math.sign(ringSignedArea(model.room.footprint.outer));
  if (!winding) return [];
  return model.landmarks.flatMap((mark, index) => {
    if (!mark.axis || !mark.elementId || !mark.rawCenter) return [];
    const [dx, dz] = mark.axis;
    const [x, y, z] = mark.rawCenter;
    return (["left", "right"] as const).map(side => {
      const offset = (side === "left" ? -1 : 1) * winding * mark.width / 2;
      const name = mark.kind === "door" ? "Door" : "Window";
      const label = `${name} ${index + 1} · top ${side}`;
      return { id: `${model.room.id}:opening:${mark.elementId}:top-${side}`,
        roomId: model.room.id, label, openingKind: mark.kind,
        point: [x + dx * offset, y + mark.height / 2, z + dz * offset] as [number, number, number] };
    });
  });
}

/** Numbered marks on the plan and equivalent list rows share the same selection action. */
export function frameCornerPicker(model: AlignmentModel, features: CalibrationFeature[],
  canChoose: (feature: CalibrationFeature) => boolean, choose: (feature: CalibrationFeature) => void): Pick<PanelPage, "wallPicker" | "rows"> {
  const choices = features.map((feature, index) => ({ feature, index })).filter(({ feature }) => canChoose(feature));
  return {
    wallPicker: {
      walls: choices.map(({ feature, index }) => ({ index, x: feature.point[0], z: feature.point[2], picked: false, enabled: true })),
      openings: model.landmarks.map(mark => ({ x: mark.center[0], z: mark.center[2], kind: mark.kind })),
      choose: index => { const feature = features[index]; if (feature && canChoose(feature)) choose(feature); },
    },
    rows: choices.map(({ feature, index }) => ({ label: `${index + 1} · ${feature.label}`, act: () => choose(feature) })),
  };
}
