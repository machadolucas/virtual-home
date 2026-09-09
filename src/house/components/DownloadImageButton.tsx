"use client";

import { useState } from "react";
import { Camera } from "lucide-react";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";

export function DownloadImageButton() {
  const runtime = useHouseRuntime();
  const ready = useHouseStore((s) => ["ready", "interactive", "degraded"].includes(s.phase));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (!runtime.captureImage) throw new Error("The 3D view is not ready for capture.");
      const blob = await runtime.captureImage();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `house-view-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      // Leave the object URL alive long enough for browsers to start reading the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      runtime.store.getState().announce("House image downloaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not capture the house view.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={() => void download()} disabled={!ready || saving}
        className="inline-flex min-h-11 md:min-h-8 items-center gap-1 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-50">
        <Camera className="size-4" aria-hidden="true" />
        {saving ? "Capturing…" : "Download image"}
      </button>
      {error ? <p role="alert" className="max-w-60 text-xs text-overdue">{error}</p> : null}
    </div>
  );
}
