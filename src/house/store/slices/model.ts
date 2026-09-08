import type { StateCreator } from "zustand";
import type { Diagnostic } from "@/house/model/crossref";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { AssetId, LoadPhase } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface PackageIssue {
  id: string;
  severity: string;
  description: string;
  affects: string[];
}

export interface ModelSlice {
  phase: LoadPhase;
  modelId: string | null;
  fingerprint: string | null;
  /** Kept out of React state elsewhere; here only so panels can read names and footprints. */
  index: ManifestIndex | null;
  diagnostics: Diagnostic[];
  issues: PackageIssue[];
  /** Asset ids the server says are present but that failed to load. */
  failedAssetIds: AssetId[];
  loadedAssetIds: AssetId[];
  tier0AssetIds: AssetId[];
  missingAssetIds: AssetId[];
  fatal: { code: string; message: string; details?: string[] } | null;

  setPhase(phase: LoadPhase): void;
  setPackage(p: {
    modelId: string;
    fingerprint: string;
    index: ManifestIndex;
    diagnostics: Diagnostic[];
    issues: PackageIssue[];
    missingAssetIds: AssetId[];
    tier0AssetIds: AssetId[];
  }): void;
  assetLoaded(id: AssetId): void;
  assetFailed(id: AssetId): void;
  setFatal(code: string, message: string, details?: string[]): void;
  resetModel(): void;
}

export const initialModel = {
  phase: "idle" as LoadPhase,
  modelId: null,
  fingerprint: null,
  index: null,
  diagnostics: [] as Diagnostic[],
  issues: [] as PackageIssue[],
  failedAssetIds: [] as AssetId[],
  loadedAssetIds: [] as AssetId[],
  tier0AssetIds: [] as AssetId[],
  missingAssetIds: [] as AssetId[],
  fatal: null,
};

export const createModelSlice: StateCreator<HouseStore, Mutators, [], ModelSlice> = (set) => ({
  ...initialModel,

  setPhase: (phase) => set({ phase }),

  setPackage: (p) =>
    set({
      modelId: p.modelId,
      fingerprint: p.fingerprint,
      index: p.index,
      diagnostics: p.diagnostics,
      issues: p.issues,
      missingAssetIds: p.missingAssetIds,
      tier0AssetIds: p.tier0AssetIds,
      fatal: null,
    }),

  assetLoaded: (id) =>
    set((s) =>
      s.loadedAssetIds.includes(id)
        ? {}
        : { loadedAssetIds: [...s.loadedAssetIds, id] },
    ),

  assetFailed: (id) =>
    set((s) =>
      s.failedAssetIds.includes(id) ? {} : { failedAssetIds: [...s.failedAssetIds, id] },
    ),

  setFatal: (code, message, details) => set({ phase: "failed", fatal: { code, message, details } }),

  resetModel: () => set({ ...initialModel }),
});
