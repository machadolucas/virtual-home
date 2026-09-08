"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { cn, focusRing } from "../cn";
import { ConnectionPill } from "../ConnectionPill";
import { TooltipProvider } from "../Tooltip";
import type { ConnectionState } from "../status";
import { GlobalSearch } from "./GlobalSearch";
import { HouseMark } from "./HouseMark";
import { MobileTabBar } from "./MobileTabBar";
import { SidebarNav } from "./SidebarNav";
import {
  getSidebarCollapsed,
  getSidebarCollapsedServer,
  subscribeSidebar,
  toggleSidebarCollapsed,
} from "./sidebarStore";
import { UserMenu } from "./UserMenu";

export interface AppShellProps {
  user: { name: string; username: string | null; displayColor: string | null };
  /** The HA link state, derived server-side from `integration_status`. */
  connection?: ConnectionState;
  children: ReactNode;
}

/**
 * Layout contract for every page under `(app)`:
 *
 *   <main> is `min-h-0 flex-1 overflow-hidden` and does NOT scroll.
 *
 * So a page either
 *   - wraps its content in a scrolling container (`PageScroll`, which every
 *     ordinary page uses), or
 *   - fills the box itself and manages its own overflow — the "workspace"
 *     layout that `/house` needs for a full-viewport 3D canvas with no page
 *     scroll and no rubber-banding on iOS.
 *
 * The shell never adds bottom padding for the phone tab bar: the tab bar is in
 * normal flow, so `<main>` already excludes it.
 */
export function AppShell({ user, connection = "unknown", children }: AppShellProps) {
  const collapsed = useSyncExternalStore(
    subscribeSidebar,
    getSidebarCollapsed,
    getSidebarCollapsedServer,
  );
  const searchRef = useRef<HTMLInputElement | null>(null);

  // `/` focuses search — but never while the user is typing somewhere else.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      const input = searchRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const registerSearch = useCallback((element: HTMLInputElement | null) => {
    searchRef.current = element;
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-paper">
        <a
          href="#main"
          className={cn(
            "sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-70",
            "focus:rounded-md focus:border focus:border-line-strong focus:bg-surface",
            "focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink",
            focusRing,
          )}
        >
          Skip to content
        </a>

        <div className="flex min-h-0 flex-1">
          <SidebarNav
            collapsed={collapsed}
            onToggle={toggleSidebarCollapsed}
            className="hidden md:flex"
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className={cn(
                "flex h-topbar shrink-0 items-center gap-2 border-b border-line bg-surface",
                "px-3 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-4",
              )}
            >
              <span className="flex shrink-0 items-center gap-2 md:hidden">
                <HouseMark className="size-5 text-accent" />
                <span className="sr-only">virtual-home</span>
              </span>
              <GlobalSearch registerInput={registerSearch} />
              <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2.5">
                <ConnectionPill state={connection} compact />
                <UserMenu
                  name={user.name}
                  username={user.username}
                  displayColor={user.displayColor}
                />
              </div>
            </header>

            <main id="main" className="min-h-0 flex-1 overflow-hidden">
              {children}
            </main>

            <MobileTabBar className="md:hidden" />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
