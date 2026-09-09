import type { StateCreator } from "zustand";
import type { Selection } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface SelectionSlice {
  selection: Selection | null;
  /** Selection whose framing action owns the transient contextual reveal. */
  focusSelection: Selection | null;
  hover: Selection | null;
  /** Text for the polite `aria-live` region; selection is never announced by colour alone. */
  announcement: string;

  setSelection(selection: Selection | null): void;
  setFocusSelection(selection: Selection | null): void;
  setHover(hover: Selection | null): void;
  announce(text: string): void;
}

export const createSelectionSlice: StateCreator<HouseStore, Mutators, [], SelectionSlice> = (
  set,
) => ({
  selection: null,
  focusSelection: null,
  hover: null,
  announcement: "",
  setSelection: (selection) => set({ selection }),
  setFocusSelection: (focusSelection) => set({ focusSelection }),
  setHover: (hover) => set({ hover }),
  announce: (announcement) => set({ announcement }),
});
