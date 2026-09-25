"use client";
import { Button } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { useFurnishings } from "./furnishings/FurnishingsProvider";
import { useFurnitureEditor } from "./furnishings/FurnitureEditorContext";
import { FurnitureInspector } from "./furnishings/FurnitureInspector";
import { PlacementEditor } from "./edit/PlacementEditor";
import { RouteEditors } from "./routeEditor/RouteEditors";
import { RouteCreateControl } from "./routeEditor/RouteCreateControl";
import { Inspector } from "./inspector/Inspector";

export function SelectionDetails() {
  const runtime=useHouseRuntime();const editing=useHouseStore(s=>s.editing);const route=useHouseStore(s=>s.routeDraft);
  const furniture=useFurnishings();const editor=useFurnitureEditor();
  if(editor.draft?.id)return <FurnitureInspector />;
  if(editing?.placementId)return <PlacementEditor />;
  if(route)return <><RouteEditors/><RouteCreateControl/></>;
  const item=furniture.items.find(i=>i.id===furniture.selectedId);
  if(item)return <div className="flex flex-col gap-3"><header><h2 className="text-base font-semibold">{item.name}</h2><p className="text-xs text-ink-3">Furniture · {runtime.store.getState().index?.floors.get(item.floorId)?.name}</p></header><dl className="grid grid-cols-2 gap-2 text-xs"><dt>Dimensions</dt><dd>{item.widthM} × {item.depthM} × {item.heightM} m</dd><dt>Position</dt><dd>{item.position.map(n=>n.toFixed(2)).join(", ")} m</dd></dl><Button size="sm" onClick={()=>furniture.requestEdit(item.id)}>Edit furniture</Button></div>;
  return <Inspector />;
}
