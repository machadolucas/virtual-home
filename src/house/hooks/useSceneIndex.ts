"use client";
import type { SceneIndex } from "@/house/scene/SceneIndex";
import { useHouseRuntime } from "./useHouseStore";

/**
 * Non-reactive access to the scene index. Reading this never subscribes a component to anything —
 * the index is mutated in place by the imperative layer, and React must not re-render for it.
 */
export function useSceneIndex(): SceneIndex | null {
  return useHouseRuntime().index;
}
