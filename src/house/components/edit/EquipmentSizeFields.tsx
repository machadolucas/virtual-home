"use client";

import { Ruler, Warehouse } from "lucide-react";
import {
  DEFAULT_WOOD_STORAGE_SIZE,
  type EquipmentSize,
} from "@/house/model/equipmentSize";
import { useHouseStore } from "../../hooks/useHouseStore";

export function EquipmentSizeFields() {
  const draft = useHouseStore((state) => state.editing);
  const update = useHouseStore((state) => state.updateDraft);
  if (!draft || draft.symbol !== "outdoor_wood_storage") return null;
  const size = draft.equipmentSize ?? DEFAULT_WOOD_STORAGE_SIZE;
  const fields: Array<[keyof EquipmentSize, string, number]> = [
    ["widthM", "Width (m)", 0.05],
    ["depthM", "Depth (m)", 0.05],
    ["heightM", "Height (m)", 0.05],
  ];

  return (
    <fieldset className="space-y-2 rounded-md border border-line p-2 text-xs">
      <legend className="flex items-center gap-1 px-1">
        <Warehouse className="size-4" aria-hidden="true" />
        Wood storage size
      </legend>
      <p className="text-ink-3">Resize the open-fronted storage shack to its physical dimensions.</p>
      <div className="grid grid-cols-3 gap-2">
        {fields.map(([key, label, step]) => (
          <label key={key} className="flex min-w-0 flex-col gap-1">
            <span className="inline-flex items-center gap-1">
              <Ruler className="size-3" aria-hidden="true" />
              {label}
            </span>
            <input
              key={`${key}:${size[key]}`}
              aria-label={`Wood storage ${label.toLowerCase()}`}
              type="number"
              min="0.1"
              max={key === "heightM" ? 10 : 20}
              step={step}
              defaultValue={size[key]}
              onBlur={(event) => {
                const value = event.currentTarget.valueAsNumber;
                const max = key === "heightM" ? 10 : 20;
                if (Number.isFinite(value) && value >= 0.1 && value <= max)
                  update({ equipmentSize: { ...size, [key]: value } }, { coalesce: true });
                else {
                  event.currentTarget.reportValidity();
                  event.currentTarget.value = String(size[key]);
                }
              }}
              className="min-h-9 w-full rounded-md border border-line px-2 font-mono max-sm:min-h-11"
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
