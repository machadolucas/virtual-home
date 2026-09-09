"use client";
import { useHouseStore } from "../../hooks/useHouseStore";
import { ElementInspector } from "./ElementInspector";
import { EquipmentInspector } from "./EquipmentInspector";
import { RoomInspector } from "./RoomInspector";
import { RouteInspector } from "./RouteInspector";
import { AnnotationInspector } from "./AnnotationInspector";
import { SurfaceInspector } from "./SurfaceInspector";
import { LabelPreferenceControl } from "./LabelPreferenceControl";
import { displayNameForNode } from "@/house/model/labelPreferences";

/** Routes the current selection to the right inspector. */
export function Inspector() {
  const selection = useHouseStore((s) => s.selection);
  const editing = useHouseStore((s) => s.editing);

  if (editing) return null; // the placement editor takes over the panel

  if (!selection)
    return (
      <p className="text-sm text-ink-3">
        Select a room, a surface or a piece of equipment — in the tree or in the 3D view.
      </p>
    );

  switch (selection.kind) {
    case "room":
      return <RoomInspector roomId={selection.id} />;
    case "surface":
      return <SurfaceInspector surfaceId={selection.id} />;
    case "element":
      return <ElementInspector elementId={selection.id} />;
    case "equipment":
      return <EquipmentInspector placementId={selection.id} />;
    case "route":
      return <RouteInspector routeId={selection.id} />;
    case "annotation":
      return <AnnotationInspector annotationId={selection.id} />;
    case "floor":
    case "building":
      return <StructureSummary kind={selection.kind} id={selection.id} />;
    default:
      return null;
  }
}

function StructureSummary({ kind, id }: { kind: "floor" | "building"; id: string }) {
  const index = useHouseStore((s) => s.index);
  const labelPreferences = useHouseStore((s) => s.labelPreferences);
  if (!index) return null;
  if (kind === "building") {
    const building = index.buildings.get(id);
    if (!building) return null;
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-ink">{building.name}</h2>
        <p className="text-xs text-ink-3">Placement: {building.placementStatus}</p>
        {building.placementNotes ? (
          <p className="text-xs text-ink-2">{building.placementNotes}</p>
        ) : null}
      </div>
    );
  }
  const floor = index.floors.get(id);
  if (!floor) return null;
  const rooms = index.roomsByFloor.get(id) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-ink">
        {displayNameForNode(floor.id, floor.name, labelPreferences)}
      </h2>
      <p className="text-xs text-ink-3">
        {floor.nameFi ? `${floor.nameFi} · ` : ""}datum {floor.elevation.toFixed(2)} m ·{" "}
        {rooms.length} rooms
      </p>
      <LabelPreferenceControl
        key={`${floor.id}:${labelPreferences.names[floor.id] ?? ""}:${String(labelPreferences.visibility[floor.id])}`}
        nodeId={floor.id}
        modelName={floor.name}
        kind="floor"
      />
    </div>
  );
}
