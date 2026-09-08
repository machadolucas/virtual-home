"use client";
/* eslint-disable react-hooks/immutability -- `HouseRuntime` is a deliberately mutable,
   non-reactive box handed around by context (see `src/house/runtime.ts`): the imperative layer
   publishes its handles onto it and React never re-renders because of it. The React Compiler
   rule assumes a hook's return value is immutable, which is precisely the assumption this
   design breaks on purpose — the alternative is putting `Object3D`s in React state. */
/**
 * Discovery + validation: `/status` → `/manifest?v=<fingerprint>` → zod → cross-references.
 *
 * The client merges its own validation with the server's asset-presence report, because the
 * browser cannot `fs.stat`. Nothing throws: a broken package becomes a `failed` phase and a
 * populated `<SetupState>`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { crossCheck, hasErrors } from "@/house/model/crossref";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { formatZodIssues, safeParseManifest } from "@/house/model/schema";
import { fetchManifestJson, fetchStatus } from "@/house/scene/loadAssets";
import type { HouseRuntime } from "../runtime";

export function useModelPackage(runtime: HouseRuntime): { reload: () => void } {
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const store = runtime.store;
    let cancelled = false;

    void (async () => {
      store.getState().setPhase("validating");
      try {
        const status = await fetchStatus(runtime.base, controller.signal);
        if (cancelled) return;
        if (!status.installed || !status.fingerprint || !status.modelId) {
          store.getState().setPackage({
            modelId: status.modelId ?? "",
            fingerprint: status.fingerprint ?? "",
            index: buildEmptyIndex(),
            diagnostics: status.diagnostics.map(toDiagnostic),
            issues: status.issues,
            missingAssetIds: [],
            tier0AssetIds: [],
          });
          store.getState().setFatal("no_package", "No model package is installed.");
          return;
        }

        const raw = await fetchManifestJson(runtime.base, status.fingerprint, controller.signal);
        if (cancelled) return;

        const parsed = safeParseManifest(raw);
        if (!parsed.success) {
          store
            .getState()
            .setFatal(
              "manifest_invalid",
              "The manifest does not match contract v1.0.",
              formatZodIssues(parsed.error),
            );
          return;
        }

        const index = buildManifestIndex(parsed.data);
        const diagnostics = [...crossCheck(parsed.data), ...status.diagnostics.map(toDiagnostic)];
        const missingAssetIds = status.assets.filter((a) => !a.present).map((a) => a.id);

        runtime.manifest = index;
        store.getState().setPackage({
          modelId: status.modelId,
          fingerprint: status.fingerprint,
          index,
          diagnostics,
          issues: status.issues,
          missingAssetIds,
          tier0AssetIds: [],
        });

        if (hasErrors(diagnostics)) {
          store.getState().setFatal(
            "package_invalid",
            "The package failed its cross-reference checks.",
            diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
          );
          return;
        }
        store.getState().setPhase("loading");
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        store
          .getState()
          .setFatal(
            "status_unavailable",
            err instanceof Error ? err.message : "Could not read the model package.",
          );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime, nonce]);

  return { reload };
}

function toDiagnostic(d: { severity: string; code: string; message: string; ids?: string[] }) {
  const severity = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info";
  return { severity, code: d.code, message: d.message, ids: d.ids } as const;
}

/** A placeholder index so the setup state can render before any manifest exists. */
function buildEmptyIndex() {
  return buildManifestIndex({
    schemaVersion: "1.0",
    modelId: "none",
    coordinateSystem: {
      units: "m",
      upAxis: "Y",
      handedness: "right",
      originDescription: "no package installed",
    },
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    buildings: [{ id: "none", name: "none", placementStatus: "unresolved", floorIds: [], assetIds: [] }],
    floors: [
      {
        id: "none",
        buildingId: "none",
        name: "none",
        elevation: 0,
        assetIds: [],
        scanAssetIds: [],
        roomIds: [],
      },
    ],
    rooms: [],
    assets: [{ id: "none", path: "assets/none.glb", kind: "shell", loadByDefault: false }],
    elements: [],
    surfaces: [],
    sources: [],
    issues: [],
  });
}
