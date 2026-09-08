"use client";
/**
 * The first-run card: how to work the 3D view, said once.
 *
 * A 3D viewport is the one part of this app that does not explain itself — nothing on screen says
 * that dragging orbits, that scrolling zooms, or that there are tools at all. Someone who has
 * never seen the app should not have to discover that by experiment.
 *
 * Shown once per browser and then dismissed for good (`localStorage`), and reachable again from
 * the keyboard-shortcut dialog, so it is a hint rather than a modal to fight past. It never blocks
 * the canvas: it sits in a corner and the view stays fully interactive behind it.
 */
import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { IconButton, Kbd } from "@/ui";

const STORAGE_KEY = "vh.house.hintsSeen";

let seenCache: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    // A browser that blocks storage shows the hint every time, which is the safe way round: an
    // extra reminder costs a glance, a missing one costs the whole interaction model.
    return false;
  }
}

function getSnapshot(): boolean {
  seenCache ??= read();
  return seenCache;
}

/** The server cannot know, and must agree with the first client render: assume seen, then correct. */
function getServerSnapshot(): boolean {
  return true;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function setHintsSeen(seen: boolean): void {
  seenCache = seen;
  try {
    if (seen) globalThis.localStorage?.setItem(STORAGE_KEY, "1");
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Not persisting is survivable; the state still applies for this session.
  }
  for (const listener of listeners) listener();
}

const GESTURES: ReadonlyArray<{ do: string; get: string }> = [
  { do: "Drag", get: "turn the house around" },
  { do: "Scroll", get: "zoom in and out" },
  { do: "Click", get: "select a room, a surface or a thing" },
  { do: "Double-click", get: "fly to what you clicked" },
];

export function CanvasHints() {
  const seen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (seen) return null;

  return (
    <aside
      aria-label="How to use the 3D view"
      className="pointer-events-auto absolute bottom-3 right-3 z-10 w-64 rounded-lg border border-line bg-surface/95 p-3 shadow-pop backdrop-blur"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-xs font-semibold text-ink">Working the 3D view</h2>
        <IconButton
          label="Dismiss this hint"
          size="sm"
          variant="ghost"
          icon={<X aria-hidden="true" />}
          onClick={() => setHintsSeen(true)}
        />
      </div>

      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] leading-4">
        {GESTURES.map((gesture) => (
          <div key={gesture.do} className="col-span-2 grid grid-cols-subgrid">
            <dt className="font-medium text-ink-2">{gesture.do}</dt>
            <dd className="text-ink-3">{gesture.get}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-2 border-t border-line pt-1.5 text-[11px] leading-4 text-ink-3">
        The tools on the left choose what dragging does. Hold <Kbd>Space</Kbd> for the camera at any
        time, and press <Kbd>?</Kbd> for every shortcut.
      </p>
    </aside>
  );
}
