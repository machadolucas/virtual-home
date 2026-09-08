"use client";
import type { ElementId } from "@/house/model/types";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { IssueList } from "./IssueList";
import { Row } from "./RoomInspector";

/** An architectural element: a wall, a door, a window, a truss. Read-only — the package is input. */
export function ElementInspector({ elementId }: { elementId: ElementId }) {
  const runtime = useHouseRuntime();
  const { index } = useHouseStore(useShallow((s) => ({ index: s.index })));
  const element = index?.elements.get(elementId);
  if (!index || !element) return null;

  const properties = Object.entries((element.properties ?? {}) as Record<string, unknown>);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold text-ink">{element.kind}</h2>
        <p className="font-mono text-[11px] text-ink-3">{element.id}</p>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Certainty" value={element.certainty} />
        <Row label="Floor" value={element.floorId ? index.floors.get(element.floorId)?.name ?? element.floorId : "—"} />
        <Row label="Building" value={element.buildingId ?? "—"} />
        <Row label="Surfaces" value={String(element.surfaceIds.length)} />
      </dl>

      {properties.length ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {properties.map(([key, value]) => (
            <Row key={key} label={key} value={formatValue(value)} />
          ))}
        </dl>
      ) : null}

      {element.note ? <p className="text-xs text-ink-2">{element.note}</p> : null}

      <ul className="flex flex-col gap-0.5">
        {element.surfaceIds.map((surfaceId) => (
          <li key={surfaceId}>
            <button
              type="button"
              onClick={() => runtime.select({ kind: "surface", id: surfaceId })}
              className="w-full truncate text-left font-mono text-[11px] text-accent-text hover:underline"
            >
              {surfaceId}
            </button>
          </li>
        ))}
      </ul>

      <IssueList issues={index.issuesByAffected.get(element.id) ?? []} />
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
