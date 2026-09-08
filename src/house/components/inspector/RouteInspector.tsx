"use client";
import { useState } from "react";
import { polylineLength } from "@/house/model/geometry2d";
import { MEDIUM_LABELS } from "@/features/projects/infraMedium";
import { isRunVisibleOn } from "@/features/projects/renovationDate";
import { NotPersistedError } from "@/house/store/dataApi";
import type { RouteDto } from "@/features/projects/wire";
import type { Route, RouteId } from "@/house/model/types";
import { CERTAINTY_LEGEND, RouteFields } from "../routeEditor/RouteFields";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { Row } from "./RoomInspector";

/**
 * A route's identity, its confidence and its lifecycle — with the confidence stated in words as
 * well as in the line style, because a drawn line is not proof of a concealed installation.
 *
 * Editing lives in `RouteFields` (the same component the 2D path editors sit beside), so the
 * non-3D route to every capability is the same whether the canvas is up or has crashed.
 *
 * Deleting is **soft** by default: the run becomes `removed` with a removal date, which is what
 * makes "why is there a capped stub behind this panel?" answerable years later. The hard delete is
 * for a line that was drawn wrongly, and the confirmation says which is which.
 */
export function RouteInspector({ routeId }: { routeId: RouteId }) {
  const runtime = useHouseRuntime();
  const { routes, index, modelId, renovationDate } = useHouseStore(
    useShallow((s) => ({
      routes: s.routes,
      index: s.index,
      modelId: s.modelId,
      renovationDate: s.renovationDate,
    })),
  );
  const beginRouteDraft = useHouseStore((s) => s.beginRouteDraft);
  const removeRoute = useHouseStore((s) => s.removeRoute);
  const upsertRoute = useHouseStore((s) => s.upsertRoute);
  const setDataError = useHouseStore((s) => s.setDataError);

  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState<null | "soft" | "hard">(null);
  const [busy, setBusy] = useState(false);

  const route = routes.find((r) => r.id === routeId) as (Route & Partial<RouteDto>) | undefined;
  if (!route || !index) return null;

  const remove = async (hard: boolean): Promise<void> => {
    if (!modelId) return;
    setBusy(true);
    const previous = route;
    // Optimistic, and honest about which of the two actually happened.
    if (hard) removeRoute(route.id);
    else upsertRoute({ ...route, lifecycle: "removed" });
    try {
      await runtime.dataApi.deleteRoute(modelId, route.id, { hard });
    } catch (err) {
      upsertRoute(previous);
      setDataError(
        err instanceof NotPersistedError
          ? `Routes are not stored yet (${err.reason}) — the removal lasts for the session only.`
          : err instanceof Error
            ? err.message
            : "The route was not removed.",
      );
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  const drawn = isRunVisibleOn(route, renovationDate);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold text-neutral-900">{route.name}</h2>
        <p className="text-xs text-neutral-500">
          {route.system} · {route.kind}
          {route.medium ? ` · ${MEDIUM_LABELS[route.medium]}` : ""}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Confidence" value={route.certainty} />
        <Row label="Lifecycle" value={route.lifecycle} />
        <Row label="Length" value={`${polylineLength(route.points).toFixed(2)} m`} />
        <Row label="Points" value={String(route.points.length)} />
        {route.nominalSize ? <Row label="Nominal size" value={route.nominalSize} /> : null}
        {route.diameterM !== undefined ? (
          <Row label="Diameter" value={`${(route.diameterM * 1000).toFixed(0)} mm`} />
        ) : null}
        {route.depthM !== undefined ? (
          <Row label="Depth into structure" value={`${route.depthM.toFixed(3)} m`} />
        ) : null}
        {route.offsetFrom ? (
          <Row
            label="Offset"
            value={`${route.offsetFrom.offsetM.toFixed(3)} m from ${route.offsetFrom.surfaceId}`}
          />
        ) : null}
        {route.installedAt ? <Row label="Installed" value={route.installedAt} /> : null}
        {route.removedAt ? <Row label="Removed" value={route.removedAt} /> : null}
        <Row label="Photos" value={String(route.photoIds.length)} />
        <Row label="Drawn now" value={drawn ? "yes" : "no — filtered by date"} />
      </dl>

      {route.note ? <p className="text-xs text-neutral-600">{route.note}</p> : null}

      <p className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
        {CERTAINTY_LEGEND} Confidence here is <strong>{route.certainty}</strong>
        {route.certainty === "inferred" || route.certainty === "unknown"
          ? " — the line is a best guess, not a verified survey."
          : "."}
      </p>

      {route.needsReconciliation ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          This route references a floor, room or surface the current model package no longer knows.
          Its polyline is intact; the ids need a human decision.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => beginRouteDraft(route)}
          className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
        >
          Edit path
        </button>
        <button
          type="button"
          aria-expanded={editing}
          onClick={() => setEditing((v) => !v)}
          className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
        >
          {editing ? "Hide details" : "Edit details"}
        </button>
      </div>

      {editing ? <RouteFields routeId={routeId} /> : null}

      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
        {armed === null ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setArmed("soft")}
              disabled={route.lifecycle === "removed"}
              className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
            >
              Mark removed
            </button>
            <button
              type="button"
              onClick={() => setArmed("hard")}
              className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
            >
              Delete — it was drawn wrongly
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-neutral-600">
              {armed === "soft"
                ? "Mark this run as removed? It keeps its path, photos and dates, and reappears whenever the renovation date reaches back past its removal."
                : "Delete this run completely? Its points and photo links go with it. Use this only for a line that was never there — a run that was taken out should be marked removed instead."}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(armed === "hard")}
                className="min-h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
              >
                {armed === "soft" ? "Mark removed" : "Delete"}
              </button>
              <button
                type="button"
                onClick={() => setArmed(null)}
                className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
              >
                Keep
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
