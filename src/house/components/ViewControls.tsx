"use client";

import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { IconButton, Tabs, TabsPanel } from "@/ui";
import { CutawayControl } from "./CutawayControl";
import { ExplodeControl } from "./ExplodeControl";
import { RouteLegend } from "./RouteLayer";
import { ViewToolbar } from "./ViewToolbar";
import { FullscreenButton } from "@/ui/FullscreenSurface";
import { CameraNavigation } from "./CameraNavigation";
import { DownloadImageButton } from "./DownloadImageButton";

const TABS = [
  { value: "view", label: "View" },
  { value: "layers", label: "Layers" },
  { value: "rendering", label: "Rendering" },
];

export function ViewControls({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }) {
  return (
    <section aria-label="View controls" className="shrink-0 overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-2 py-1">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">View controls</span>
        <div className="min-w-0 flex-1">
          <ViewToolbar section="presets" />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <CameraNavigation />
          <FullscreenButton />
          <DownloadImageButton />
          <IconButton
            label={collapsed ? "Show the view controls" : "Collapse the view controls"}
            size="sm"
            icon={collapsed ? <PanelBottomOpen aria-hidden="true" /> : <PanelBottomClose aria-hidden="true" />}
            onClick={onToggle}
            aria-expanded={!collapsed}
          />
        </div>
      </div>
      <div hidden={collapsed}>
        <Tabs items={TABS} ariaLabel="View control groups">
          <TabsPanel value="view" className="max-h-48 overflow-y-auto p-2">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-x-4 gap-y-2">
              <CameraNavigation inputOnly />
              <CutawayControl />
              <ExplodeControl />
            </div>
          </TabsPanel>
          <TabsPanel value="layers" className="max-h-48 overflow-y-auto p-2">
            <div className="flex flex-wrap items-start gap-4">
              <ViewToolbar section="layers" />
              <RouteLegend />
            </div>
          </TabsPanel>
          <TabsPanel value="rendering" className="h-56 overflow-y-auto">
            <ViewToolbar section="rendering" />
          </TabsPanel>
        </Tabs>
      </div>
    </section>
  );
}
