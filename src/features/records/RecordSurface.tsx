"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import { recordHasUnsavedEdits, subscribeUnsaved } from "@/features/forms/unsaved";
import { RecordActivityProvider } from "./RecordActivity";
import { deriveNavigation, matchingNavigation, type RecordNavigation } from "./navigation";
import { Sheet } from "@/ui/Sheet";

type Entry = { href: string; hub: string; title: string; children: ReactNode; intercepted: boolean; opener: HTMLElement | null; generation?: number; navigation?:RecordNavigation };
const Records = createContext<((entry: Omit<Entry,"opener">) => () => void) | null>(null);
/** Retained editor bodies live above route slots; changing a URL never silently discards a draft. */
export function RecordSurfaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname(); const router = useRouter();const search=useSearchParams().toString();
  const [session]=useState(()=>crypto.randomUUID());
  const lastLocation=useRef({path:pathname,url:`${pathname}${search?`?${search}`:""}`});
  const transition=useRef<{to:string;from:string}|null>(null);
  const lastNavigation=useRef<RecordNavigation|null>(null);
  const pendingFrom=useRef(new Map<string,string>());
  useEffect(()=>{const url=`${pathname}${search?`?${search}`:""}`;if(lastLocation.current.url!==url){transition.current={to:pathname,from:lastLocation.current.url};lastLocation.current={path:pathname,url};}if(history.state?.vhRecord && history.state.vhRecord.href!==pathname){const {vhRecord:_record,...rest}=history.state;void _record;history.replaceState(rest,"",location.href);}},[pathname,search]);
  const previousPath=useRef(pathname);
  const openers=useRef(new Map<string,HTMLElement>());
  const originOpeners=useRef(new Map<string,HTMLElement>());
  useEffect(()=>{const capture=(event:MouseEvent)=>{if(event.button!==0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)return;const link=event.target instanceof Element?event.target.closest<HTMLAnchorElement>("a[href]"):null;if(!link)return;const url=new URL(link.href,location.href);if(url.origin===location.origin){openers.current.set(url.pathname,link);pendingFrom.current.set(url.pathname,`${location.pathname}${location.search}${location.hash}`);if(openers.current.size>50)openers.current.delete(openers.current.keys().next().value!);}};document.addEventListener("click",capture,true);return()=>document.removeEventListener("click",capture,true);},[]);
  const mounts=useRef(new Map<symbol,{href:string;intercepted:boolean}>());
  const [entries, setEntries] = useState<Map<string,Entry>>(new Map());
  const [dirtyPaths,setDirtyPaths]=useState<string[]>([]);
  useEffect(()=>{const update=()=>setDirtyPaths([...entries.keys()].filter(recordHasUnsavedEdits));update();return subscribeUnsaved(update);},[entries]);
  useEffect(()=>{const discard=(event:Event)=>{const href=(event as CustomEvent<string>).detail;setTimeout(()=>setEntries(previous=>{const next=new Map(previous);next.delete(href);return next;}),0);};window.addEventListener("vh-record-discard",discard);return()=>window.removeEventListener("vh-record-discard",discard);},[]);
  useEffect(()=>{
    const previous=previousPath.current;previousPath.current=pathname;
    if(previous===pathname || !previous.endsWith("/new") || recordHasUnsavedEdits(previous))return;
    const timer=setTimeout(()=>setEntries(current=>{const entry=current.get(previous);if(!entry)return current;const next=new Map(current);next.set(previous,{...entry,generation:(entry.generation??0)+1});return next;}),0);
    return()=>clearTimeout(timer);
  },[pathname]);
  const register = useCallback((entry: Omit<Entry,"opener">) => {
    let navigation:RecordNavigation|undefined;
    if(location.pathname===entry.href) {
      const from=pendingFrom.current.get(entry.href) ?? (transition.current?.to===entry.href ? transition.current.from : lastLocation.current.url);
      navigation=deriveNavigation({session,href:entry.href,hub:entry.hub,intercepted:entry.intercepted,from,previous:lastNavigation.current,marker:pendingFrom.current.has(entry.href)?undefined:history.state?.vhRecord});
      if(!navigation.direct && navigation.depth===1){const opener=openers.current.get(entry.href);if(opener)originOpeners.current.set(navigation.origin,opener);}
      pendingFrom.current.delete(entry.href);
      history.replaceState({...history.state,vhRecord:navigation},"",location.href);
      lastNavigation.current=navigation;
    }
    const token=Symbol();mounts.current.set(token,{href:entry.href,intercepted:entry.intercepted});
    setEntries(previous => {
      const existing = previous.get(entry.href);
      if (existing && existing.children === entry.children && existing.intercepted === entry.intercepted && (!navigation || existing.navigation===navigation)) return previous;
      const next = new Map(previous);
      next.set(entry.href, {...entry, children: existing && recordHasUnsavedEdits(entry.href) ? existing.children : entry.children, generation: existing?.generation, navigation:navigation ?? existing?.navigation, opener: (navigation && originOpeners.current.get(navigation.origin)) ?? openers.current.get(entry.href) ?? existing?.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)});
      for (const [key] of next) { if(next.size <= 6)break; if(key !== entry.href && !recordHasUnsavedEdits(key))next.delete(key); }
      return next;
    });
    return ()=>{mounts.current.delete(token);setEntries(previous=>{const cached=previous.get(entry.href);if(!cached)return previous;const intercepted=[...mounts.current.values()].some(mount=>mount.href===entry.href && mount.intercepted);if(cached.intercepted===intercepted)return previous;const next=new Map(previous);next.set(entry.href,{...cached,intercepted});return next;});};
  }, [session]);
  return <Records.Provider value={register}><RecordActivityProvider active={![...entries.values()].some(entry=>entry.href===pathname)}>{children}</RecordActivityProvider>{dirtyPaths.length>0 && <details className="fixed bottom-20 right-3 z-20 max-w-xs rounded-lg border border-line bg-surface p-3 text-sm shadow-overlay"><summary className="cursor-pointer">{dirtyPaths.length} unsaved {dirtyPaths.length===1?"draft":"drafts"}</summary><ul>{dirtyPaths.map(href=><li key={href}><Link href={href as Route} scroll={false} className="block py-2 text-accent-text">{entries.get(href)?.title}</Link></li>)}</ul></details>}{[...entries.values()].map(entry => <RetainedRecord key={`${entry.href}:${entry.generation??0}`} entry={entry} active={pathname === entry.href} close={() => {
    const navigation=matchingNavigation(history.state?.vhRecord,session,entry.href) ?? entry.navigation;
    if(navigation && !navigation.direct && navigation.depth>0) history.go(-navigation.depth);
    else router.replace((navigation?.origin ?? entry.hub) as Route,{scroll:false});
  }} />)}</Records.Provider>;
}
function RetainedRecord({entry,active,close}:{entry:Entry;active:boolean;close:()=>void}) {
  const returnFocusRef=useRef<HTMLElement|null>(entry.opener);
  useEffect(()=>{returnFocusRef.current=entry.opener;},[entry.opener]);
  return <Sheet open={active} onOpenChange={open=>{if(!open)close();}} keepMounted returnFocusRef={returnFocusRef} title={entry.title} description="Close to return to your starting view. Unfinished edits are kept until you save or cancel." side="right" className="!inset-y-0 !right-0 !max-h-dvh !w-screen sm:!w-[min(76rem,calc(100vw-3rem))] !rounded-none" >
    <div data-record-scope={entry.href} className="record-content min-h-0"><RecordActivityProvider active={active}>{entry.children}</RecordActivityProvider></div>
  </Sheet>;
}
/** Shared adapter for a direct URL (hub behind it) and an intercepted contextual navigation. */
export function RecordSurface({href,hub,title,children,intercepted=false}:Omit<Entry,"opener"|"intercepted">&{intercepted?:boolean}) {
  const register=useContext(Records);
  const entry=useMemo(()=>({href,hub,title,children,intercepted}),[href,hub,title,children,intercepted]);
  useEffect(()=>register?.(entry),[register,entry]);
  return null;
}
