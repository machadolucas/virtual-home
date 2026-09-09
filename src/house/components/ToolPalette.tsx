"use client";
/**
 * The tool palette: which gesture the left button performs, in the Photoshop sense.
 *
 * It sits *over* the canvas rather than in the inspector because it changes what the pointer does
 * in the canvas, and a control that changes the meaning of a gesture belongs next to the gesture.
 * Each tool carries its one-key shortcut in the tooltip — that is how anyone learns there are
 * shortcuts at all.
 *
 * The palette also states the escape hatch (hold Space for the camera), because a locked camera
 * with no visible way back is the kind of thing that makes a 3D view feel broken rather than modal.
 */
import { Hand, MousePointer2, MapPin } from "lucide-react";
import { Tooltip } from "@/ui";
import { cn } from "@/ui/cn";
import { CANVAS_TOOLS, type CanvasTool } from "@/house/store/slices/view";
import { useHouseStore, useShallow } from "../hooks/useHouseStore";

const TOOL_META: {
  readonly [T in CanvasTool]: { label: string; key: string; hint: string; icon: React.ReactNode };
} = {
  orbit: {
    label: "Orbit the camera",
    key: "C",
    hint: "Drag to turn the house around.",
    icon: <Hand aria-hidden="true" className="size-4" />,
  },
  select: {
    label: "Select",
    key: "V",
    hint: "Click to pick a room, a surface or a piece of equipment. The camera stays put.",
    icon: <MousePointer2 aria-hidden="true" className="size-4" />,
  },
  place: {
    label: "Place",
    key: "M",
    hint: "Click to place. Wheel zoom and right-drag pan stay available; hold Space to orbit.",
    icon: <MapPin aria-hidden="true" className="size-4" />,
  },
};

export function ToolPalette() {
  const { tool, setTool, editing, cameraOverride } = useHouseStore(
    useShallow((s) => ({
      tool: s.tool,
      setTool: s.setTool,
      editing: s.editing,
      cameraOverride: s.cameraOverride,
    })),
  );

  return (
    <div
      role="radiogroup"
      aria-label="Pointer tool"
      className="pointer-events-auto absolute left-2 top-2 z-10 flex flex-col gap-1 rounded-lg border border-line bg-surface/95 p-1 shadow-pop backdrop-blur"
    >
      {CANVAS_TOOLS.map((value) => {
        const meta = TOOL_META[value];
        const active = tool === value;
        return (
          <Tooltip key={value} side="right" align="start" shortcut={meta.key} content={meta.hint}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${meta.label} (${meta.key})`}
              onClick={() => setTool(value)}
              className={cn(
                "flex size-8 items-center justify-center rounded-md border",
                active
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-transparent text-ink-2 hover:bg-surface-3",
              )}
            >
              {meta.icon}
            </button>
          </Tooltip>
        );
      })}

      {editing ? (
        <span className="mx-auto size-1.5 rounded-full bg-accent" aria-label="Placement active" />
      ) : null}
      {cameraOverride ? <span className="sr-only">Camera temporarily active</span> : null}
    </div>
  );
}
