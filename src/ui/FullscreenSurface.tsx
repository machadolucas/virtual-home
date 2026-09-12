"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize, Minimize } from "lucide-react";
import { IconButton } from "./IconButton";
import { OverlayScope } from "./OverlayContainer";
import { cn } from "./cn";

const FullscreenContext = createContext({ active: false, toggle: () => {} });

/** The same subtree stays mounted in browser fullscreen and the phone fallback. */
export function FullscreenSurface({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const wasNative = useRef(false);
  const bindContainer = useCallback((element: HTMLDivElement | null) => { ref.current = element; setContainer(element); }, []);
  const previousFocus = useRef<HTMLElement | null>(null);
  const leave = useCallback(() => {
    setActive(false);
    previousFocus.current?.focus();
  }, []);
  const toggle = useCallback(async () => {
    if (active) {
      if (document.fullscreenElement === ref.current) await document.exitFullscreen().catch(() => {});
      leave();
      return;
    }
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActive(true);
    try {
      // A document opened inside a fullscreen workspace expands within that existing surface.
      // Replacing the native element would make exiting the document also exit the workspace.
      if (!document.fullscreenElement) await ref.current?.requestFullscreen?.();
    } catch { /* Immersive viewport fallback. */ }
  }, [active, leave]);
  useEffect(() => {
    const sync = () => {
      if (document.fullscreenElement === ref.current) wasNative.current = true;
      else if (document.fullscreenElement && ref.current?.contains(document.fullscreenElement)) return;
      else if (wasNative.current) { wasNative.current = false; leave(); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active && !document.fullscreenElement && !event.defaultPrevented &&
          !(event.target as HTMLElement)?.closest('[role="dialog"], [role="listbox"]')) leave();
    };
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("fullscreenchange", sync); window.removeEventListener("keydown", escape); };
  }, [active, leave]);
  return <div ref={bindContainer} data-fullscreen={active || undefined} className={cn(active ? "fixed inset-0 z-30 h-dvh w-screen bg-paper" : "relative h-full min-h-0", className)}>
    <FullscreenContext.Provider value={{ active, toggle }}>
      <OverlayScope container={active ? container ?? undefined : undefined}>{children}</OverlayScope>
    </FullscreenContext.Provider>
  </div>;
}

export function FullscreenButton() {
  const { active, toggle } = useContext(FullscreenContext);
  return <IconButton label={active ? "Exit fullscreen" : "Fullscreen"} icon={active ? <Minimize /> : <Maximize />} onClick={toggle} aria-pressed={active} size="sm" />;
}
