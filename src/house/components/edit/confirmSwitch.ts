"use client";
import type { HouseRuntime } from "@/house/runtime";
/** No change is discarded until the user explicitly chooses to leave the current edit. */
export function confirmEditSwitch(runtime: HouseRuntime): boolean {
  const state = runtime.store.getState();
  if (state.editorSaving || state.furnishingsEditing) {
    state.announce("Finish the current edit before starting another.");
    return false;
  }
  if (state.editing?.dirty || state.routeDraft) {
    if (typeof window === "undefined" || !window.confirm("Discard the current unsaved edit and start this one? Choose Cancel to keep working on it.")) return false;
  }
  if (state.editing) state.cancelEdit();
  if (state.routeDraft) state.cancelRouteDraft();
  return true;
}
