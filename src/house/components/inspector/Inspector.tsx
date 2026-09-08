"use client";
import { useHouseStore } from "../../hooks/useHouseStore";
import { ElementInspector } from "./ElementInspector";
import { EquipmentInspector } from "./EquipmentInspector";
import { RoomInspector } from "./RoomInspector";
import { RouteInspector } from "./RouteInspector";
import { AnnotationInspector } from "./AnnotationInspector";
import { SurfaceInspector } from "./SurfaceInspector";

/** Routes the current selection to the right inspector. */
export function Inspector() {
  const selection = useHouseStore((s) => s.selection);
  const editing = useHouseStore((s) => s.editing);

  if (editing) return null; // the placement editor takes over the panel

  if (!selection)
    return (
      <p className="text-sm text-neutral-500">
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
  if (!index) return null;
  if (kind === "building") {
    const building = index.buildings.get(id);
    if (!building) return null;
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-neutral-900">{building.name}</h2>
        <p className="text-xs text-neutral-500">Placement: {building.placementStatus}</p>
        {building.placementNotes ? (
          <p className="text-xs text-neutral-600">{building.placementNotes}</p>
        ) : null}
      </div>
    );
  }
  const floor = index.floors.get(id);
  if (!floor) return null;
  const rooms = index.roomsByFloor.get(id) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-neutral-900">{floor.name}</h2>
      <p className="text-xs text-neutral-500">
        {floor.nameFi ? `${floor.nameFi} · ` : ""}datum {floor.elevation.toFixed(2)} m ·{" "}
        {rooms.length} rooms
      </p>
    </div>
  );
}
