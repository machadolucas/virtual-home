"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ListTree, SlidersHorizontal, Info } from "lucide-react";
import { Button, Sheet } from "@/ui";
import { FullscreenButton } from "@/ui/FullscreenSurface";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { FloorControls } from "../ViewToolbar";
import { HouseCanvasLazy } from "../HouseCanvasLazy";
import { HouseErrorBoundary } from "../HouseErrorBoundary";
import { LocateSheet } from "./LocateSheet";
import { useFurnitureEditor } from "../furnishings/FurnitureEditorContext";
import { useFurnishings } from "../furnishings/FurnishingsProvider";
import { ScopedBrowser } from "../ScopedBrowser";
import { SelectionDetails } from "../SelectionDetails";
import { ToolPalette } from "../ToolPalette";
import { CameraNavigation } from "../CameraNavigation";
import { CanvasHints } from "../CanvasHints";
import { ViewSettings } from "../ViewControls";
import { DownloadImageButton } from "../DownloadImageButton";
import { RoutePath3D } from "../routeEditor/RoutePath3D";

type Panel="browse"|"details"|"view"|null;
export function PhoneHouse({workspaceRef}:{workspaceRef:RefObject<HTMLDivElement|null>}){
 const runtime=useHouseRuntime();const [panel,setPanel]=useState<Panel>(null);
 const panelRef=useRef<Panel>(null);useEffect(()=>{panelRef.current=panel;},[panel]);
 const browseButton=useRef<HTMLButtonElement>(null),detailsButton=useRef<HTMLButtonElement>(null),viewButton=useRef<HTMLButtonElement>(null);
 const furniture=useFurnitureEditor();const furnishings=useFurnishings();
 const state=useHouseStore(useShallow(s=>({index:s.index,selection:s.selection,background:s.background,editing:s.editing,routeDraft:s.routeDraft,newRoute:s.routeDraftIsNew,saving:s.editorSaving,announcement:s.announcement})));
 useEffect(()=>runtime.store.subscribe((next,previous)=>{
   if(next.editing&&!previous.editing)setPanel(next.editing.placementId?"details":"browse");
   else if(next.routeDraft&&!previous.routeDraft)setPanel(next.routeDraftIsNew?"browse":"details");
   else if(next.selection&&next.selection!==previous.selection&&panelRef.current===null)setPanel("details");
 }),[runtime]);
 useEffect(()=>{if(!furnishings.selectedId)return;const id=requestAnimationFrame(()=>setPanel("details"));return()=>cancelAnimationFrame(id);},[furnishings.selectedId]);
 const equipmentId=state.selection?.kind==="equipment"?state.selection.id:null;
 const editing=!!state.editing||!!state.routeDraft||!!furniture.draft;
 return <div ref={workspaceRef} tabIndex={-1} className="relative flex h-full min-h-0 flex-col bg-paper" data-testid="vh-phone-workspace">
  <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2 py-1"><button onClick={()=>setPanel("browse")} className="min-h-11 min-w-0 flex-1 truncate text-left text-sm font-medium">House</button><FullscreenButton/></header>
  <div className="relative min-h-0 flex-1" role="application" tabIndex={0} aria-label="House 3D view"><HouseErrorBoundary><HouseCanvasLazy background={state.background}/></HouseErrorBoundary><ToolPalette/><div className="absolute right-2 top-2 rounded-md border border-line bg-surface/95"><CameraNavigation/></div><CanvasHints compact/>{state.routeDraft?<RoutePath3D/>:null}</div>
  <nav aria-label="House tools" className="grid shrink-0 grid-cols-3 gap-1 border-t border-line bg-surface px-2 py-1"><Button ref={browseButton} variant="ghost" icon={<ListTree/>} onClick={()=>setPanel("browse")}>Browse / Add</Button><Button ref={detailsButton} variant="ghost" icon={<Info/>} onClick={()=>setPanel("details")}>Details</Button><Button ref={viewButton} variant="ghost" icon={<SlidersHorizontal/>} onClick={()=>setPanel("view")}>View</Button></nav>
  <Sheet keepMounted returnFocusRef={browseButton} open={panel==="browse"} onOpenChange={open=>{if(!open)setPanel(null);}} title="Browse and add" description="Find a place or add an item to your house."><ScopedBrowser onInspect={()=>setPanel("details")}/></Sheet>
  <Sheet keepMounted returnFocusRef={detailsButton} open={panel==="details"} onOpenChange={open=>{if(!open&&!state.saving)setPanel(null);}} title="Selected item" description={editing?"Close to keep this draft; Save or Cancel finishes it.":"Inspect the selection or open its full record."}>
   {equipmentId&&!state.editing?<LocateSheet placementId={equipmentId}/>:null}<SelectionDetails/>
   {!editing&&(state.selection||furnishings.selectedId)?<Button variant="ghost" onClick={()=>{runtime.select(null);furnishings.select(null);setPanel(null);}}>Deselect</Button>:null}
  </Sheet>
  <Sheet keepMounted returnFocusRef={viewButton} open={panel==="view"} onOpenChange={open=>{if(!open)setPanel(null);}} title="View settings" description="Change how the house is shown."><FloorControls inline/><ViewSettings/><DownloadImageButton/></Sheet>
  <p aria-live="polite" className="sr-only">{state.announcement}</p>
 </div>;
}
