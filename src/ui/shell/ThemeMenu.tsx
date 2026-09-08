"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { SegmentedControl } from "../SegmentedControl";
import { getTheme, getThemeServer, setTheme, subscribeTheme } from "./themeStore";
import type { ThemeChoice } from "./theme";

const ITEMS = [
  { value: "system" as const, label: "System", icon: <Monitor aria-hidden="true" /> },
  { value: "light" as const, label: "Light", icon: <Sun aria-hidden="true" /> },
  { value: "dark" as const, label: "Dark", icon: <Moon aria-hidden="true" /> },
];

/**
 * System / Light / Dark, inside the account menu.
 *
 * It is a `SegmentedControl` rather than a single toggle because there are genuinely three states,
 * and "System" is not the same answer as "Light" — a laptop that switches at sunset is a different
 * preference from one pinned bright. Radix gives it one tab stop and arrow keys between segments.
 *
 * Nothing here is persisted server-side: it is per browser, and it grants nothing. The one household
 * setting that *is* shared is the 3D background (Settings → Household → Appearance), which says so
 * in its own copy.
 */
export function ThemeMenu() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getThemeServer);

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1">
      <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-3">
        Appearance
      </span>
      <SegmentedControl<ThemeChoice>
        ariaLabel="Appearance"
        size="sm"
        fullWidth
        value={theme}
        onValueChange={setTheme}
        items={ITEMS}
      />
    </div>
  );
}
