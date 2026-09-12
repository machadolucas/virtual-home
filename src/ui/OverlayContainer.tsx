"use client";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
const OverlayContainer = createContext<HTMLElement | undefined>(undefined);
export const OverlayContainerProvider = OverlayContainer.Provider;
const subscribe = (listener: () => void) => { document.addEventListener("fullscreenchange", listener); return () => document.removeEventListener("fullscreenchange", listener); };
const snapshot = () => document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : undefined;
/** Portals remain inside the active fullscreen element, including nested document viewers. */
export function useOverlayContainer() {
  const local = useContext(OverlayContainer);
  const fullscreen = useSyncExternalStore(subscribe, snapshot, () => undefined);
  return local && (!fullscreen || fullscreen.contains(local)) ? local : fullscreen;
}
export function OverlayScope({ children, container }: { children: ReactNode; container: HTMLElement | undefined }) {
  const inherited = useContext(OverlayContainer);
  return <OverlayContainer.Provider value={container ?? inherited}>{children}</OverlayContainer.Provider>;
}
