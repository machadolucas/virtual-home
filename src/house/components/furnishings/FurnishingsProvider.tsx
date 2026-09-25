"use client";

import { registerFurnishingSelection } from "../../scene/furnishingSelection";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Furnishing } from "@/house/model/types";
import { useHouseRuntime, useHouseStore } from "../../hooks/useHouseStore";

interface FurnishingsValue {
  items: Furnishing[];
  selectedId: string | null;
  select(id: string | null): void;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Load the list again after a failed load. */
  retry(): void;
  preview: Furnishing | null;
  setPreview(item: Furnishing | null): void;
  requestEdit(id: string): void;
  registerEditHandler(handler: ((id: string) => void) | null): void;
  save(item: Omit<Furnishing, "modelId" | "id"> & { id?: string }): Promise<Furnishing>;
  remove(id: string): Promise<void>;
}

const Context = createContext<FurnishingsValue | null>(null);

export function FurnishingsProvider({ children }: { children: React.ReactNode }) {
  const runtime = useHouseRuntime();
  const modelId = useHouseStore((s) => s.modelId);
  const fingerprint = useHouseStore((s) => s.fingerprint);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const select = useCallback((id: string | null) => { runtime.select(null); setSelectedId(id); }, [runtime]);
  useEffect(() => runtime.store.subscribe((next, previous) => { if (next.selection !== previous.selection) setSelectedId(null); }), [runtime]);
  useEffect(()=>registerFurnishingSelection(runtime,id=>{if(id!==null)runtime.select(null);setSelectedId(id);}),[runtime]);
  const [items, setItems] = useState<Furnishing[]>([]);
  const [loadedFingerprint, setLoadedFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const retry = useCallback(() => { setError(null); setLoadNonce((value) => value + 1); }, []);
  const [preview, setPreview] = useState<Furnishing | null>(null);
  const editHandler = useRef<((id: string) => void) | null>(null);
  const requestEdit = useCallback((id: string) => editHandler.current?.(id), []);
  const registerEditHandler = useCallback((handler: ((id: string) => void) | null) => { editHandler.current = handler; }, []);

  useEffect(() => {
    if (!modelId || !fingerprint) return;
    const controller = new AbortController();
    void fetch(`${runtime.base}/furnishings`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load furniture (${response.status})`);
        return response.json() as Promise<{ furnishings?: Furnishing[] }>;
      })
      .then((body) => {
        setItems(body.furnishings ?? []);
        setLoadedFingerprint(fingerprint);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load furniture");
      });
    return () => controller.abort();
  }, [runtime.base, modelId, fingerprint, loadNonce]);

  const save = useCallback(async (item: Omit<Furnishing, "modelId" | "id"> & { id?: string }) => {
    if (!modelId || !fingerprint) throw new Error("The house model is not ready");
    if (loadedFingerprint !== fingerprint) throw new Error("Wait for the furniture list to load");
    setBusy(true);
    try {
      const response = await fetch(`${runtime.base}/furnishings`, {
        method: "PUT", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint, viewMode: "normal", furnishing: item }),
      });
      const body = await response.json().catch(() => ({})) as { furnishing?: Furnishing; error?: string };
      if (!response.ok || !body.furnishing) throw new Error(body.error ?? "Could not save furniture");
      setItems((current) => [...current.filter((x) => x.id !== body.furnishing!.id), body.furnishing!]
        .sort((a, b) => a.name.localeCompare(b.name)));
      setError(null);
      return body.furnishing;
    } finally { setBusy(false); }
  }, [fingerprint, loadedFingerprint, modelId, runtime.base]);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${runtime.base}/furnishings?id=${encodeURIComponent(id)}`, {
        method: "DELETE", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not delete furniture");
      setItems((current) => current.filter((x) => x.id !== id));
      setError(null);
    } finally { setBusy(false); }
  }, [runtime.base]);

  const loading = !!fingerprint && loadedFingerprint !== fingerprint;
  const value = useMemo(() => ({ items, selectedId, select, loading, error, busy, retry, preview, setPreview, requestEdit, registerEditHandler, save, remove }), [items, selectedId, select, loading, error, busy, retry, preview, requestEdit, registerEditHandler, save, remove]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useFurnishings(): FurnishingsValue {
  const value = useContext(Context);
  if (!value) throw new Error("useFurnishings must be inside FurnishingsProvider");
  return value;
}
