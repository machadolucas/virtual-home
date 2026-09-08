"use client";
import { useEffect } from "react";
import type { RefObject } from "react";
import type { FloorId } from "@/house/model/types";

/**
 * The §11.2 shortcut map, on **one** `keydown` listener on the workspace root — not on `window` —
 * so the rest of the app is unaffected when the workspace is not focused.
 *
 * Suppressed while focus is in a text input, a `<select>` or a `contenteditable`, and while a
 * modifier that belongs to the browser (Meta/Ctrl/Alt) is held.
 */
export interface ShortcutHandlers {
  isolateFloorByIndex(n: number): void;
  allFloors(): void;
  resetOverview(): void;
  frameSelection(): void;
  escape(): void;
  toggleEdit(): void;
  planView(): void;
  toggleSection(): void;
  toggleExplode(): void;
  toggleRoof(): void;
  toggleCeilings(): void;
  toggleEdges(): void;
  dollhouse(): void;
  nudgeCut(delta: number): void;
  rotateSelection(delta: number): void;
  orbit(azimuth: number, polar: number): void;
  truck(dx: number, dy: number): void;
  dolly(delta: number): void;
  focusSearch(): void;
  showHelp(): void;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(
  rootRef: RefObject<HTMLElement | null>,
  handlers: ShortcutHandlers,
  enabled = true,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const shift = event.shiftKey;
      const step = shift ? 0.01 : 0.1;
      let handled = true;

      switch (event.key) {
        case "1":
        case "2":
        case "3":
          handlers.isolateFloorByIndex(Number(event.key) - 1);
          break;
        case "0":
          handlers.allFloors();
          break;
        case "r":
        case "R":
          handlers.resetOverview();
          break;
        case "f":
        case "F":
          handlers.frameSelection();
          break;
        case "Escape":
          handlers.escape();
          break;
        case "e":
        case "E":
          handlers.toggleEdit();
          break;
        case "p":
        case "P":
          handlers.planView();
          break;
        case "s":
        case "S":
          handlers.toggleSection();
          break;
        case "x":
        case "X":
          handlers.toggleExplode();
          break;
        case "h":
        case "H":
          handlers.toggleRoof();
          break;
        case "g":
        case "G":
          handlers.toggleCeilings();
          break;
        case "b":
        case "B":
          handlers.toggleEdges();
          break;
        case "d":
        case "D":
          handlers.dollhouse();
          break;
        case "[":
          handlers.nudgeCut(-step);
          break;
        case "]":
          handlers.nudgeCut(step);
          break;
        case ",":
          handlers.rotateSelection(-15);
          break;
        case ".":
          handlers.rotateSelection(15);
          break;
        case "ArrowUp":
          if (shift) handlers.truck(0, 0.4);
          else handlers.orbit(0, -5);
          break;
        case "ArrowDown":
          if (shift) handlers.truck(0, -0.4);
          else handlers.orbit(0, 5);
          break;
        case "ArrowLeft":
          if (shift) handlers.truck(-0.4, 0);
          else handlers.orbit(-5, 0);
          break;
        case "ArrowRight":
          if (shift) handlers.truck(0.4, 0);
          else handlers.orbit(5, 0);
          break;
        case "+":
        case "=":
          handlers.dolly(0.6);
          break;
        case "-":
          handlers.dolly(-0.6);
          break;
        case "/":
          handlers.focusSearch();
          break;
        case "?":
          handlers.showHelp();
          break;
        default:
          handled = false;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [rootRef, handlers, enabled]);
}

/** The help dialog's contents, kept next to the map so the two cannot drift. */
export const SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "1 / 2 / 3", action: "Isolate the first / second / third floor" },
  { keys: "0", action: "All floors (overview)" },
  { keys: "R", action: "Reset to the property overview" },
  { keys: "F", action: "Frame the current selection" },
  { keys: "Esc", action: "Clear selection; cancel edit; close a sheet" },
  { keys: "E", action: "Toggle placement edit mode" },
  { keys: "P", action: "Top-down plan of the active floor" },
  { keys: "S", action: "Toggle the section cut" },
  { keys: "X", action: "Toggle exploded floors (off during edit)" },
  { keys: "H", action: "Roof visibility" },
  { keys: "G", action: "Ceiling visibility" },
  { keys: "B", action: "Architectural edges" },
  { keys: "D", action: "Dollhouse preset" },
  { keys: "[ / ]", action: "Cut height −/+ 0.10 m (Shift: 0.01 m)" },
  { keys: ", / .", action: "Rotate the selection −/+ 15° (edit mode)" },
  { keys: "Arrows", action: "Orbit 5°; Shift+arrows truck; + / − dolly" },
  { keys: "F6", action: "Cycle tree / canvas / inspector" },
  { keys: "/", action: "Focus search" },
  { keys: "?", action: "This help" },
];

export function floorIdByIndex(order: readonly FloorId[], n: number): FloorId | null {
  return order[n] ?? null;
}
