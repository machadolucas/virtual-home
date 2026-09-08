"use client";
/**
 * Endpoint data for the two forms that need it: the endpoint editor and the route form's
 * from/to pickers.
 *
 * The workspace shell hydrates colours, placements, routes and annotations but not endpoints, so
 * this hook loads them on mount and keeps them in the store — one list, so the route form and the
 * endpoint form can never disagree about what exists. A second mount finds the list already there
 * and does not refetch.
 *
 * Everything here goes through `runtime.dataApi`, which means the in-memory implementation works
 * exactly the same: an endpoint created before the model package is imported degrades to the
 * session store with the UI saying so, rather than losing the user's typing.
 */
import { useCallback, useEffect, useState } from "react";
import type { EndpointDto, EndpointWrite } from "@/features/projects/wire";
import { NotPersistedError } from "@/house/store/dataApi";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";

/**
 * Stores whose endpoint list has already been fetched. Three panels use this hook at once (the
 * route form's two pickers, the endpoint list and the inspector's details), and one list is one
 * request. Keyed by the store rather than by `modelId` so a remounted workspace — new store, empty
 * list — fetches again instead of showing nothing.
 */
const fetched = new WeakSet<object>();

export interface EndpointCatalog {
  endpoints: EndpointDto[];
  /** True until the first fetch has answered, so an empty list can say which empty it is. */
  loading: boolean;
  /** A message to show the user, already written for them. `null` when nothing is wrong. */
  error: string | null;
  save(endpoint: EndpointWrite): Promise<EndpointDto | null>;
  remove(endpointId: string): Promise<boolean>;
}

export function useEndpoints(): EndpointCatalog {
  const runtime = useHouseRuntime();
  const { endpoints, modelId, fingerprint } = useHouseStore(
    useShallow((s) => ({
      endpoints: s.endpoints,
      modelId: s.modelId,
      fingerprint: s.fingerprint,
    })),
  );
  const setEndpoints = useHouseStore((s) => s.setEndpoints);
  const upsertEndpoint = useHouseStore((s) => s.upsertEndpoint);
  const removeEndpoint = useHouseStore((s) => s.removeEndpoint);
  const setDataError = useHouseStore((s) => s.setDataError);
  /**
   * Settled rather than loading, and written only from the fetch's own callbacks: setting a flag
   * in the effect body would be a cascading render (and the lint rule that says so is right).
   * "Loading" is then derived, which also gets the "no model yet" case right for free.
   */
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!modelId) return;
    // Already loaded, or in flight from a sibling panel — one fetch is enough.
    if (fetched.has(runtime.store) || runtime.store.getState().endpoints.length > 0) return;
    fetched.add(runtime.store);
    let cancelled = false;
    void runtime.dataApi
      .listEndpoints(modelId)
      .then((list) => {
        if (!cancelled) setEndpoints(list);
      })
      .catch((err: unknown) => {
        // A missing endpoints resource disables two pickers; it must never break the panel. The
        // mark is dropped so a later mount retries rather than inheriting a failed fetch.
        fetched.delete(runtime.store);
        if (!cancelled && !(err instanceof NotPersistedError))
          setError(err instanceof Error ? err.message : "The endpoint list did not load.");
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, modelId, setEndpoints]);

  const save = useCallback(
    async (endpoint: EndpointWrite): Promise<EndpointDto | null> => {
      if (!modelId || !fingerprint) return null;
      setError(null);
      try {
        const stored = await runtime.dataApi.saveEndpoint(modelId, fingerprint, endpoint);
        upsertEndpoint(stored);
        return stored;
      } catch (err) {
        if (err instanceof NotPersistedError)
          setDataError(
            `Endpoints are not stored yet (${err.reason}) — this one lasts for the session only.`,
          );
        else setError(err instanceof Error ? err.message : "The endpoint was not saved.");
        return null;
      }
    },
    [runtime, modelId, fingerprint, upsertEndpoint, setDataError],
  );

  const remove = useCallback(
    async (endpointId: string): Promise<boolean> => {
      if (!modelId) return false;
      setError(null);
      const previous = runtime.store.getState().endpoints.find((e) => e.id === endpointId);
      // Optimistic, and put back exactly as it was when the server refuses.
      removeEndpoint(endpointId);
      try {
        await runtime.dataApi.deleteEndpoint(modelId, endpointId);
        return true;
      } catch (err) {
        if (previous) upsertEndpoint(previous);
        setError(err instanceof Error ? err.message : "The endpoint was not removed.");
        return false;
      }
    },
    [runtime, modelId, removeEndpoint, upsertEndpoint],
  );

  const loading = modelId !== null && !settled && endpoints.length === 0 && error === null;
  return { endpoints, loading, error, save, remove };
}

export interface EquipmentHit {
  assetId: string;
  label: string;
  secondary: string | null;
}

/**
 * Equipment matching `query`, for the "link an existing unit" picker.
 *
 * The household search index answers this already (`/api/search?q=`), and reusing it means the
 * endpoint form finds a unit by its model number the same way the header search does. It is
 * capped per group, which is why the caller shows "narrow it" rather than claiming a complete list.
 */
export async function searchEquipment(
  query: string,
  signal?: AbortSignal,
): Promise<{ hits: EquipmentHit[]; hasMore: boolean }> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`equipment search → ${res.status}`);
  const body = (await res.json()) as {
    groups?: Array<{
      kind: string;
      hits: Array<{ id: string; label: string; secondary: string | null }>;
      hasMore: boolean;
    }>;
  };
  const group = body.groups?.find((g) => g.kind === "equipment");
  return {
    hits: (group?.hits ?? []).map((h) => ({
      assetId: h.id,
      label: h.label,
      secondary: h.secondary,
    })),
    hasMore: group?.hasMore ?? false,
  };
}
