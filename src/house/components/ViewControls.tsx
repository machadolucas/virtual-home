"use client";

import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { IconButton, Tabs, TabsPanel } from "@/ui";
import { CutawayControl } from "./CutawayControl";
import { ExplodeControl } from "./ExplodeControl";
import { RouteLegend } from "./RouteLayer";
import { ViewToolbar } from "./ViewToolbar";
import { DownloadImageButton } from "./DownloadImageButton";

const TABS = [
  { value: "view", label: "View" },
  { value: "layers", label: "Layers" },
  { value: "rendering", label: "Rendering" },
];

export function ViewControls({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }) {
  return (
    <section aria-label="View controls" className="shrink-0 overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        <span className="text-xs font-medium text-ink-2">View controls</span>
        <ViewToolbar section="presets" />
        <div className="ml-auto flex items-center gap-1">
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
        <Tabs items={TABS} ariaLabel="View control groups" className="border-t border-line">
          <TabsPanel value="view" className="max-h-48 overflow-y-auto p-2">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-x-4 gap-y-2">
              <ViewToolbar section="view" />
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
          <TabsPanel value="rendering" className="max-h-48 overflow-y-auto p-2">
            <ViewToolbar section="rendering" />
          </TabsPanel>
        </Tabs>
      </div>
    </section>
  );
}
