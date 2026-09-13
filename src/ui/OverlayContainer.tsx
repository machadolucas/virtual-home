"use client";
import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
const OverlayContainer = createContext<HTMLElement | undefined>(undefined);
export const OverlayContainerProvider = OverlayContainer.Provider;
const activeHosts: HTMLElement[] = [];
export function registerOverlayHost(host: HTMLElement) {
  activeHosts.push(host); document.dispatchEvent(new Event("vh-overlay-host"));
  return () => { const index=activeHosts.lastIndexOf(host); if(index>=0)activeHosts.splice(index,1); document.dispatchEvent(new Event("vh-overlay-host")); };
}
const subscribe = (listener: () => void) => { document.addEventListener("fullscreenchange", listener); document.addEventListener("vh-overlay-host",listener); return () => {document.removeEventListener("fullscreenchange", listener);document.removeEventListener("vh-overlay-host",listener);}; };
const snapshot = () => activeHosts.filter(host=>host.isConnected && (!document.fullscreenElement || document.fullscreenElement.contains(host))).at(-1) ?? (document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : undefined);
/** Portals remain inside the active fullscreen element, including nested document viewers. */
export function useOverlayContainer(owner?: RefObject<HTMLElement | null>) {
  const local = useContext(OverlayContainer);
  const fullscreen = useSyncExternalStore(subscribe,snapshot,()=>undefined);
  const candidate=local && (!fullscreen || fullscreen.contains(local)) ? local : fullscreen;
  const [safeContainer,setSafeContainer]=useState(candidate);
  useLayoutEffect(()=>{
    // Native fullscreen changes DOM portal ownership. Retain the prior parent when the new host
    // is inside this dialog; reparenting into a descendant would destroy its own viewer.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize imperative DOM ancestry before paint.
    if(!candidate || !owner?.current?.contains(candidate)) setSafeContainer(candidate);
  },[candidate,owner]);
  return owner ? safeContainer : candidate;
}
export function OverlayScope({ children, container }: { children: ReactNode; container: HTMLElement | undefined }) {
  const inherited = useContext(OverlayContainer);
  return <OverlayContainer.Provider value={container ?? inherited}>{children}</OverlayContainer.Provider>;
}
