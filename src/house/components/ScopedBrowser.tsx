"use client";

import { useMemo, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Armchair, Box, ChevronRight, Focus, House, Layers, MapPin, Plus, Route, Trees } from "lucide-react";
import { Button, Input } from "@/ui";
import { buildPropertyTree, type PropertyTreeNode } from "../model/propertyTree";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useFurnishings } from "./furnishings/FurnishingsProvider";
import { useFurnitureEditor } from "./furnishings/FurnitureEditorContext";
import { FurnitureInspector } from "./furnishings/FurnishingsPanel";
import { PlaceableList } from "./edit/PlaceableList";
import { PlacementEditor } from "./edit/PlacementEditor";
import { requestEditSwitch } from "./edit/confirmSwitch";
import { NewEquipmentForm } from "./edit/NewEquipmentForm";
import { NewTreeForm } from "./edit/NewTreeForm";
import { RouteCreateControl } from "./routeEditor/RouteCreateControl";
import { RouteEditors } from "./routeEditor/RouteEditors";
import { EndpointPanel } from "./routeEditor/EndpointPanel";
import { NewAnnotation } from "./NewAnnotation";

type Category = "places" | "equipment" | "furniture" | "infrastructure" | "trees";
const categories = [{id:"places",label:"Rooms",icon:House},{id:"equipment",label:"Equipment",icon:Box},{id:"furniture",label:"Furniture",icon:Armchair},{id:"infrastructure",label:"Infrastructure",icon:Route},{id:"trees",label:"Trees",icon:Trees}] as const;
type AddKind = "equipment" | "furniture" | "infrastructure" | "endpoint" | "tree" | "note";

/** Browsing never starts an edit or moves the camera; those are explicit row actions. */
export function ScopedBrowser({ searchRef, onInspect }: { searchRef?: RefObject<HTMLInputElement | null>; onInspect?:()=>void }) {
  const runtime = useHouseRuntime();
  const searchParams = useSearchParams();
  const state = useHouseStore(useShallow(s=>({index:s.index,placements:s.placements,routes:s.routes,labels:s.labelPreferences,selection:s.selection,editing:s.editing,routeDraft:s.routeDraft,routeNew:s.routeDraftIsNew})));
  const furniture = useFurnishings();
  const editor = useFurnitureEditor();
  const [scope,setScope] = useState<string|null>(()=>searchParams.get("scope")==="trees"?"outside":null);
  const [category,setCategory] = useState<Category>(()=>searchParams.get("scope")==="trees"?"trees":"places");
  const [query,setQuery] = useState("");
  const [add,setAdd] = useState<AddKind|null>(null);
  const [menu,setMenu] = useState(false);
  const nodes = useMemo(()=>{
    const result = state.index ? buildPropertyTree({index:state.index,placements:state.placements,routes:state.routes,furnishings:furniture.items,labelPreferences:state.labels}) : new Map<string,PropertyTreeNode>();
    // Outside remains a useful empty destination before the first garden object is recorded.
    if(state.index && !result.has("outside")) result.set("outside",{id:"outside",label:"Outside",depth:0,kind:"outside",selection:null,children:[],parent:null});
    return result;
  },[state.index,state.placements,state.routes,furniture.items,state.labels]);
  const ancestors = (node:PropertyTreeNode) => { const out:PropertyTreeNode[]=[];let parent=node.parent;while(parent){const item=nodes.get(parent);if(!item)break;out.unshift(item);parent=item.parent;}return out; };
  const current = scope ? nodes.get(scope) : null;
  const spatial = (n:PropertyTreeNode)=>["building","floor","room","outside"].includes(n.kind);
  const crumbs = current ? [...ancestors(current),current].filter(spatial) : [];
  const inScope = (node:PropertyTreeNode) => !current || ancestors(node).some(n=>n.id===current.id) || (current.kind==="room" && ((node.kind==="equipment" && state.placements.find(p=>p.id===node.selection?.id)?.roomId===current.selection?.id) || (node.kind==="furnishing" && furniture.items.find(f=>f.id===node.furnishingId)?.roomId===current.selection?.id)));
  const matchesCategory=(node:PropertyTreeNode)=> {
    const tree=node.kind==="equipment"&&state.placements.find(p=>p.id===node.selection?.id)?.symbol==="tree";
    if(category==="trees")return tree;
    if(category==="equipment")return node.kind==="equipment"&&!tree;
    if(category==="furniture")return node.kind==="furnishing";
    if(category==="infrastructure")return node.kind==="route";
    return spatial(node)||node.kind==="surface"||node.kind==="element";
  };
  const candidates=[...nodes.values()].filter(node=>query ? !["section","route-group"].includes(node.kind)&&`${node.label} ${ancestors(node).map(n=>n.label).join(" ")}`.toLowerCase().includes(query.toLowerCase()) : inScope(node)&&matchesCategory(node));
  const seen=new Set<string>();
  const rows=candidates.filter(node=>{const key=node.furnishingId??(node.selection?`${node.selection.kind}:${node.selection.id}`:node.id);if(seen.has(key))return false;seen.add(key);return true;}).filter(node=>query||category!=="places"||!ancestors(node).some(n=>spatial(n)&&n.id!==current?.id&&(!current||ancestors(n).some(a=>a.id===current.id))));
  const inspect=(node:PropertyTreeNode)=>{void requestEditSwitch(runtime,()=>{furniture.select(null);if(node.furnishingId)furniture.select(node.furnishingId);else runtime.select(node.selection);onInspect?.();});};
  const browse=(node:PropertyTreeNode)=>{setScope(node.id);if(node.kind==="outside")setCategory("trees");};
  const creatingPlacement=!!state.editing&&!state.editing.placementId;
  const creatingFurniture=editor.catalogOpen||!!editor.draft&&!editor.draft.id;
  const creatingRoute=!!state.routeDraft&&state.routeNew;
  const activeCreation=creatingPlacement||creatingFurniture||creatingRoute;
  const begin=(kind:AddKind)=>{setMenu(false);requestEditSwitch(runtime,()=>{if(current?.selection)runtime.select(current.selection);setAdd(kind==="furniture"?null:kind);if(kind==="furniture")editor.setCatalogOpen(true);});};
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Browse house</h2><Button size="sm" icon={<Plus />} onClick={()=>setMenu(!menu)} aria-expanded={menu}>Add</Button></div>
    {menu ? <div aria-label="Add to house" className="grid grid-cols-2 gap-1 rounded-md border border-line bg-surface-2 p-1">{([{id:"equipment",label:"Equipment"},{id:"furniture",label:"Furniture"},{id:"tree",label:"Tree"},{id:"infrastructure",label:"Pipe, duct or cable"},{id:"endpoint",label:"Inlet or endpoint"},{id:"note",label:"Note or measurement"}] as const).map(item=><Button key={item.id} size="sm" variant="ghost" onClick={()=>begin(item.id)}>{item.label}</Button>)}</div>:null}
    <div hidden={!activeCreation}>
      {creatingPlacement ? <PlacementEditor /> : creatingFurniture ? <FurnitureInspector /> : creatingRoute ? <><RouteEditors /><RouteCreateControl /></> : null}
    </div>
    <div hidden={activeCreation||!add}>
      {add ? <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={()=>{setAdd(null);editor.setCatalogOpen(false);}}>Back to browse</Button> : null}
      <div data-unsaved hidden={add!=="tree"}>{add==="tree" ? <NewTreeForm runtime={runtime} onCancelled={()=>setAdd(null)} onStarted={()=>setAdd(null)} /> : null}</div>
      <div data-unsaved hidden={add!=="equipment"}>{add==="equipment" ? <><NewEquipmentForm runtime={runtime} onCancelled={()=>setAdd(null)} onStarted={()=>setAdd(null)}/><PlaceableList /></> : null}</div>
      {add==="infrastructure" ? <RouteCreateControl /> : add==="endpoint" ? <EndpointPanel /> : add==="note" ? <NewAnnotation /> : null}
    </div>
    <div hidden={activeCreation||!!add} className="min-h-0">
      <nav aria-label="House location" className="mb-2 flex flex-wrap items-center gap-1 text-xs"><button className="min-h-8 text-accent-text" onClick={()=>setScope(null)}>Property</button>{crumbs.map(n=><span className="flex items-center gap-1" key={n.id}><ChevronRight className="size-3"/><button className="min-h-8 max-w-36 truncate" onClick={()=>setScope(n.id)}>{n.label}</button></span>)}</nav>
      <Input ref={searchRef} type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search the whole property…" aria-label="Search the property" />
      <div aria-label="Browse category" className="my-2 flex flex-wrap gap-1">{categories.map(c=><button key={c.id} aria-pressed={category===c.id} className={`inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs ${category===c.id?"bg-accent-soft text-accent-text":"bg-surface-2 text-ink-2"}`} onClick={()=>{setCategory(c.id);setQuery("");}}><c.icon className="size-3.5"/>{c.label}</button>)}</div>
      <p className="mb-1 text-[11px] text-ink-3">{rows.length} {query?"matches":"items"}{query?" across the property":""}</p>
      <ul className="flex flex-col gap-1" aria-label="House items">{rows.map(node=>{const selected=node.furnishingId?furniture.selectedId===node.furnishingId:node.selection&&state.selection?.kind===node.selection.kind&&state.selection.id===node.selection.id;const Icon=node.kind==="furnishing"?Armchair:node.kind==="route"?Route:node.kind==="equipment"?Box:node.kind==="room"?House:Layers;return <li key={node.id} className={`flex items-center rounded-md ${selected?"bg-accent-soft":"hover:bg-surface-2"}`}><button onClick={()=>inspect(node)} aria-pressed={!!selected} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-left"><Icon className="size-4 shrink-0 text-ink-3"/><span className="min-w-0"><span className="block truncate text-sm">{node.label}</span><span className="block truncate text-[11px] text-ink-3">{query?ancestors(node).filter(spatial).map(n=>n.label).join(" · "):node.secondary??node.kind}</span></span></button>{node.selection?<button aria-label={`Frame ${node.label}`} title="Frame in model" className="min-h-8 min-w-8 text-ink-3" onClick={()=>void requestEditSwitch(runtime,()=>{furniture.select(null);runtime.select(node.selection,{frame:true});onInspect?.();})}><Focus className="mx-auto size-4"/></button>:null}{spatial(node)?<button aria-label={`Browse ${node.label}`} className="min-h-8 min-w-8" onClick={()=>browse(node)}><ChevronRight className="mx-auto size-4"/></button>:null}</li>;})}</ul>
      {!rows.length?<div className="py-4 text-sm text-ink-3"><MapPin className="mb-2 size-5"/>{query?"No matching items. Try another name or location.":"Nothing here yet. Use Add to record an item."}</div>:null}
      {category==="equipment" || query ? <PlaceableList search={query || undefined} /> : null}
      {category==="infrastructure" ? <EndpointPanel /> : null}
    </div>
  </div>;
}
