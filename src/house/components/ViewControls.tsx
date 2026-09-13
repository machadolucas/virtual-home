"use client";

import { SlidersHorizontal } from "lucide-react";
import { Button, Popover } from "@/ui";
import { CutawayControl } from "./CutawayControl";
import { ExplodeControl } from "./ExplodeControl";
import { RouteLegend } from "./RouteLayer";
import { ViewToolbar, RenderingControls } from "./ViewToolbar";
import { FullscreenButton } from "@/ui/FullscreenSurface";
import { CameraNavigation } from "./CameraNavigation";
import { DownloadImageButton } from "./DownloadImageButton";

/** One set of presentation controls for the desktop popover and phone sheet. */
export function ViewSettings() {
  return <div className="grid min-w-0 gap-2 text-xs">
    <details open className="border-b border-line pb-2"><summary className="min-h-8 cursor-pointer py-2 font-semibold">Visibility</summary><ViewToolbar section="layers" /><RouteLegend /></details>
    <details className="border-b border-line pb-2"><summary className="min-h-8 cursor-pointer py-2 font-semibold">Cut and separation</summary><div className="grid gap-3 sm:grid-cols-2"><CutawayControl /><ExplodeControl /></div></details>
    <details className="border-b border-line pb-2"><summary className="min-h-8 cursor-pointer py-2 font-semibold">Lighting</summary><RenderingControls section="lighting" /></details>
    <details className="border-b border-line pb-2"><summary className="min-h-8 cursor-pointer py-2 font-semibold">Appearance</summary><RenderingControls section="appearance" /></details>
    <details><summary className="min-h-8 cursor-pointer py-2 font-semibold">Advanced</summary><CameraNavigation inputOnly /><RenderingControls section="advanced" /></details>
  </div>;
}

export function ViewControls() {
  return <div aria-label="View controls" className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface/95 p-1 shadow-pop backdrop-blur">
    <ViewToolbar section="presets" />
    <CameraNavigation />
    <FullscreenButton />
    <DownloadImageButton />
    <Popover ariaLabel="View settings" align="end" className="w-[36rem] !max-w-[calc(100vw-2rem)]" trigger={<Button size="sm" variant="ghost" icon={<SlidersHorizontal />}>View</Button>}><ViewSettings /></Popover>
  </div>;
}
