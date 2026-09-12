"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearUnsavedEdits, confirmDiscardEdits, editorScope, hasUnsavedEdits, markEditorDirty, subscribeUnsaved } from "./unsaved";
/** Protect marked editors and defer remote refreshes until locally typed work has been saved. */
export function EditorGuard() {
  const pathname = usePathname(); const router = useRouter();
  useEffect(() => {
    clearUnsavedEdits();
    let deferredRefresh = false; let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let sentinel = false; let consuming = false;
    const flush = () => {
      if (hasUnsavedEdits()) {deferredRefresh=true;return;}
      deferredRefresh=false; clearTimeout(refreshTimer); refreshTimer=setTimeout(()=>router.refresh(),250);
    };
    const dirtyChanged = () => {
      if (hasUnsavedEdits() && !sentinel) {
        // One same-URL entry lets Back ask before the editor is unmounted.
        history.pushState({...history.state, vhEditorGuard:true}, "", location.href); sentinel=true;
      }
      if (!hasUnsavedEdits() && deferredRefresh) flush();
    };
    const unsub = subscribeUnsaved(dirtyChanged);
    const changed = (event: Event) => {
      const scope = editorScope(event.target);
      if (scope) markEditorDirty(scope);
    };
    const click = (event: MouseEvent) => {
      if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]");
      if(link && !link.download && (!link.target || link.target === "_self")) {
        const url = new URL(link.href,location.href);
        if(url.pathname === location.pathname && url.search === location.search) return;
        if(!confirmDiscardEdits()){event.preventDefault();event.stopPropagation();}
      }
      const cancel = target?.closest<HTMLButtonElement>("button[data-discard-editor]");
      if(cancel && !confirmDiscardEdits()){event.preventDefault();event.stopPropagation();}
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {if(hasUnsavedEdits()){event.preventDefault();event.returnValue="";}};
    const pop = (event: PopStateEvent) => {
      if(consuming){consuming=false;event.stopImmediatePropagation();return;}
      if(!sentinel)return;
      event.stopImmediatePropagation();
      if(confirmDiscardEdits()){sentinel=false;history.back();}
      else {consuming=true;history.forward();}
    };
    const source = new EventSource("/api/events"); let connectedOnce=false;
    source.addEventListener("open",()=>{if(connectedOnce)flush();connectedOnce=true;});
    source.addEventListener("resync",flush);
    source.addEventListener("batch",event=>{
      try {const payload=JSON.parse((event as MessageEvent).data) as {items?: {topic?:string}[]}; if(payload.items?.some(item=>item.topic && item.topic!=="ha.state"))flush();}catch{/* Ignore malformed transport frames. */}
    });
    window.addEventListener("beforeunload",beforeUnload);
    window.addEventListener("popstate",pop,true);
    document.addEventListener("input",changed,true); document.addEventListener("change",changed,true); document.addEventListener("click",click,true);
    return () => {unsub();source.close();clearTimeout(refreshTimer);window.removeEventListener("beforeunload",beforeUnload);window.removeEventListener("popstate",pop,true);document.removeEventListener("input",changed,true);document.removeEventListener("change",changed,true);document.removeEventListener("click",click,true);};
  },[pathname,router]);
  return null;
}
