"use client";

import { useState } from "react";
import { Switch, toasts } from "@/ui";
import { displayNameForNode, labelVisibleForNode } from "@/house/model/labelPreferences";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { RotateCcw, Save } from "lucide-react";

export function LabelPreferenceControl({
  nodeId,
  modelName,
  kind,
  defaultVisible = true,
}: {
  nodeId: string;
  modelName: string;
  kind: "room" | "floor";
  defaultVisible?: boolean;
}) {
  const runtime = useHouseRuntime();
  const { preferences, modelId, fingerprint } = useHouseStore(
    useShallow((state) => ({
      preferences: state.labelPreferences,
      modelId: state.modelId,
      fingerprint: state.fingerprint,
    })),
  );
  const hydrate = useHouseStore((state) => state.hydrateLabelPreferences);
  const resolvedName = displayNameForNode(nodeId, modelName, preferences);
  const resolvedVisible = labelVisibleForNode(nodeId, preferences, defaultVisible);
  const [name, setName] = useState(preferences.customNames[nodeId] ?? resolvedName);
  const [visible, setVisible] = useState(resolvedVisible);
  const [saving, setSaving] = useState(false);

  const save = async (reset = false) => {
    if (!modelId || !fingerprint || saving) return;
    setSaving(true);
    try {
      const next = await runtime.dataApi.saveLabelPreference(modelId, fingerprint, {
        nodeId,
        displayName:
          reset || (preferences.customNames[nodeId] === undefined && name.trim() === resolvedName)
            ? null
            : name.trim(),
        visible: reset ? null : visible,
      });
      hydrate(next);
      setName(next.customNames[nodeId] ?? displayNameForNode(nodeId, modelName, next));
      setVisible(labelVisibleForNode(nodeId, next, defaultVisible));
      toasts.success(reset ? "Label defaults restored" : "Label saved");
    } catch (error) {
      toasts.error("Could not save label", error instanceof Error ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const hasOverride =
    preferences.customNames[nodeId] !== undefined ||
    preferences.customVisibility[nodeId] !== undefined;
  const usesMappedName = !preferences.customNames[nodeId] && resolvedName !== modelName;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-2.5">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          {kind === "floor" ? "3D floor labels" : "3D area label"}
        </h3>
        {usesMappedName ? (
          <p className="mt-0.5 text-[11px] text-ink-3">Using the automatic name.</p>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-xs text-ink-2">
        Display name
        <input
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.currentTarget.value)}
          className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
        />
      </label>
      <Switch
        checked={visible}
        onCheckedChange={setVisible}
        controlPosition="start"
        label={kind === "floor" ? "Show area labels on this floor" : "Show this area label"}
        className="min-h-9 text-xs"
      />
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={saving || name.trim().length === 0}
          onClick={() => void save()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-on-accent disabled:opacity-50"
        >
          <Save aria-hidden="true" className="size-3.5" />
          {saving ? "Saving…" : "Save label"}
        </button>
        {hasOverride ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(true)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs font-medium text-ink disabled:opacity-50"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Reset label settings
          </button>
        ) : null}
      </div>
    </section>
  );
}
