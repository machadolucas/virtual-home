"use client";
/**
 * Typed store access.
 *
 * `useShallow` is re-exported here so a multi-field selector always has it to hand: zustand 5
 * dropped the implicit shallow comparison, so a bare object selector re-renders on every store
 * write. Rule of thumb enforced by review: a selector that returns an object goes through
 * `useShallow`; one that returns a primitive does not need it.
 */
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/shallow";
import type { HouseRuntime } from "../runtime";
import type { HouseStore } from "../store/createHouseStore";

export const HouseRuntimeContext = createContext<HouseRuntime | null>(null);

export function useHouseRuntime(): HouseRuntime {
  const runtime = useContext(HouseRuntimeContext);
  if (!runtime) throw new Error("useHouseRuntime must be used inside <HouseWorkspace>");
  return runtime;
}

export function useHouseStore<T>(selector: (state: HouseStore) => T): T {
  return useStore(useHouseRuntime().store, selector);
}

export { useShallow };
