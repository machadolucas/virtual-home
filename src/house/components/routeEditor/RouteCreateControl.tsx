"use client";
/**
 * The way into the infrastructure data: create a run, draw it, save it — and record the inlets,
 * outlets, shutoffs and meters it runs between.
 *
 * Everything downstream of this already existed. `infra_route` and `infra_endpoint`, their API
 * handlers, the 2D plan and wall-elevation editors, the 3D line layer and the route inspector were
 * all in place; the only thing missing was a first `beginRouteDraft` for a run that does not exist
 * yet, and any way at all to create an endpoint. So this component deliberately builds nothing new
 * for drawing: the points are dragged in `PlanEditor2D` / `WallElevationEditor2D` (mounted by the
 * workspace whenever a draft is open) and in the 3D handles, and this panel is the create form, the
 * numeric fallback for those handles, and the save.
 *
 * Two things it insists on:
 *
 *  - **Confidence is a required answer, defaulted to `inferred`.** A drawn line is not proof of a
 *    concealed installation, and the legend from `RouteFields` is repeated here rather than being
 *    left for the user to find later.
 *  - **Saving is explicit.** The draft is mirrored into the route list so the 3D line follows the
 *    points as they move, but nothing reaches the server until "Save path". Closing the path editor discards any unsaved changes.
 */
import { useState } from "react";
import type { InfraCertainty, InfraLifecycle, InfraMedium } from "@/db/schema/infrastructure";
import { MEDIUM_LABELS, kindOfMedium, systemOfMedium } from "@/features/projects/infraMedium";
import { ENDPOINT_KIND_SHORT } from "@/features/projects/infraEndpoint";
import { CERTAINTIES, LIFECYCLES, MEDIA, type RouteDto } from "@/features/projects/wire";
import { polylineLength } from "@/house/model/geometry2d";
import { roomAt } from "@/house/model/manifestIndex";
import { routePointPlace } from "@/house/model/routePlaces";
import type { FloorId, Route, Vec3 } from "@/house/model/types";
import { NotPersistedError, type RouteSave } from "@/house/store/dataApi";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { CERTAINTY_LEGEND } from "./RouteFields";
import { EndpointPanel } from "./EndpointPanel";
import { startRouteDraft } from "./startRouteDraft";
import { useEndpoints } from "./useEndpoints";
import { Select } from "@/ui/Select";

const INPUT = "min-h-8 rounded-md border border-line px-2 text-xs";
const BUTTON =
  "min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-50";

/** The route facts the client `Route` type has no field for, held here while the draft is open. */
interface Extras {
  medium: InfraMedium;
  nominalSize: string;
  fromEndpointId: string;
  toEndpointId: string;
}

function extrasOf(draft: Route & Partial<RouteDto>): Extras {
  return {
    // A draft opened from the inspector is the stored DTO, so its medium is the stored one; a
    // draft this panel started always carries one. The system default is the last resort only.
    medium: draft.medium ?? "cold_water",
    nominalSize: draft.nominalSize ?? "",
    fromEndpointId: draft.fromEndpointId ?? "",
    toEndpointId: draft.toEndpointId ?? "",
  };
}

export function RouteCreateControl() {
  const runtime = useHouseRuntime();
  const { index, modelId, fingerprint, routeDraft, routeDraftIsNew } =
    useHouseStore(
      useShallow((s) => ({
        index: s.index,
        modelId: s.modelId,
        fingerprint: s.fingerprint,
        routeDraft: s.routeDraft as (Route & Partial<RouteDto>) | null,
        routeDraftIsNew: s.routeDraftIsNew,
      })),
    );
  const upsertRoute = useHouseStore((s) => s.upsertRoute);
  const cancelRouteDraft = useHouseStore((s) => s.cancelRouteDraft);
  const endRouteDraft = useHouseStore((s) => s.endRouteDraft);
  const setDataError = useHouseStore((s) => s.setDataError);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [medium, setMedium] = useState<InfraMedium>("supply_air");
  const [certainty, setCertainty] = useState<InfraCertainty>("inferred");
  const [lifecycle, setLifecycle] = useState<InfraLifecycle>("installed");
  const [nominalSize, setNominalSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saving = useHouseStore((s) => s.editorSaving);
  const setSaving = useHouseStore((s) => s.setEditorSaving);
  /** Keyed by draft id, like `RouteFields`: switching draft derives fresh values in one render. */
  const [held, setHeld] = useState<{ routeId: string; extras: Extras } | null>(null);

  const extras: Extras | null =
    routeDraft && held?.routeId === routeDraft.id
      ? held.extras
      : routeDraft
        ? extrasOf(routeDraft)
        : null;
  const setExtras = (next: Extras): void => {
    if (routeDraft) setHeld({ routeId: routeDraft.id, extras: next });
  };

  if (!index) return null;

  const start = (): void => {
    setError(null);
    if (name.trim() === "") {
      setError("Give the run a name — “Kitchen extract duct” is what makes it findable later.");
      return;
    }
    const started = startRouteDraft(runtime, {
      name: name.trim(),
      medium,
      certainty,
      lifecycle,
      nominalSize: nominalSize.trim() === "" ? null : nominalSize.trim(),
    });
    if (!started) {
      setError("There is no model package loaded to draw into.");
      return;
    }
    setCreating(false);
    setName("");
    setNominalSize("");
  };

  const save = async (): Promise<void> => {
    if (saving || !routeDraft || !extras || !modelId || !fingerprint) return;
    setError(null);
    const candidate: RouteSave = {
      ...routeDraft,
      medium: extras.medium,
      system: systemOfMedium(extras.medium),
      kind: kindOfMedium(extras.medium),
      nominalSize: extras.nominalSize.trim() === "" ? null : extras.nominalSize.trim(),
      fromEndpointId: extras.fromEndpointId === "" ? null : extras.fromEndpointId,
      toEndpointId: extras.toEndpointId === "" ? null : extras.toEndpointId,
    };
    setSaving(true);
    // Optimistic: the scene reads the route list, so the line is already where the user put it.
    upsertRoute(candidate);
    try {
      const stored = await runtime.dataApi.saveRoute(modelId, fingerprint, candidate);
      upsertRoute(stored);
      endRouteDraft();
    } catch (err) {
      if (err instanceof NotPersistedError) {
        setDataError(
          `Routes are not stored yet (${err.reason}) — this run lasts for the session only.`,
        );
        endRouteDraft();
      } else {
        setError(err instanceof Error ? err.message : "The run was not saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    if (saving || !routeDraft) return;
    cancelRouteDraft();
    setError(null);
  };

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Pipes, ducts and cables
        </h3>
        {routeDraft ? null : (
          <button
            type="button"
            className={BUTTON}
            aria-expanded={creating}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "Cancel" : "New route"}
          </button>
        )}
      </header>

      {creating && !routeDraft ? (
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kitchen extract duct"
              maxLength={200}
              className={INPUT}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-ink-2">Carries</span>
              <Select
                selectSize="sm"
                value={medium}
                onValueChange={(value) => setMedium(value as InfraMedium)}
                options={MEDIA.map((value) => ({ value, label: MEDIUM_LABELS[value] }))}
              />
              <span className="text-[11px] text-ink-3">
                Drawn as a {kindOfMedium(medium)} in the {systemOfMedium(medium)} system.
              </span>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-ink-2">Size (optional)</span>
              <input
                value={nominalSize}
                onChange={(e) => setNominalSize(e.target.value)}
                placeholder="DN20, Cat6a, Ø125 mm"
                maxLength={60}
                className={INPUT}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-ink-2">Confidence</span>
              <Select
                selectSize="sm"
                value={certainty}
                onValueChange={(value) => setCertainty(value as InfraCertainty)}
                options={CERTAINTIES.map((value) => ({ value, label: value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-ink-2">Lifecycle</span>
              <Select
                selectSize="sm"
                value={lifecycle}
                onValueChange={(value) => setLifecycle(value as InfraLifecycle)}
                /* `removed` is not offered: a newly drawn run is installed or planned. */
                options={LIFECYCLES.filter((value) => value !== "removed").map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </label>
          </div>

          <p className="rounded-md border border-line bg-surface p-2 text-[11px] text-ink-2">
            {CERTAINTY_LEGEND} Start at <strong>inferred</strong> unless the run was actually opened
            up and measured.
          </p>

          <div className="flex gap-2">
            <button type="button" className={BUTTON} onClick={start}>
              Start drawing
            </button>
            <button type="button" className={BUTTON} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-ink-3">
            The first two points appear across the selected room, or across this floor when no room
            is selected. Nothing is stored until you save the path.
          </p>
        </div>
      ) : null}

      {routeDraft && extras ? (
        <DraftPath
          draft={routeDraft}
          extras={extras}
          setExtras={setExtras}
          isNew={routeDraftIsNew}
          saving={saving}
          onSave={() => void save()}
          onDiscard={discard}
        />
      ) : null}

      {error ? (
        <p role="alert" className="text-[11px] text-overdue">
          {error}
        </p>
      ) : null}

      <EndpointPanel />
    </section>
  );
}

/**
 * The draft's points as numbers, plus what it runs between, plus the save.
 *
 * The numeric list is not a duplicate of the plan editor: it is the non-3D route to the same
 * capability (the workspace's standing rule), it is the only way to set a point's height while the
 * plan editor is the one open, and it is what makes "move it 40 mm" possible at all.
 */
function DraftPath({
  draft,
  extras,
  setExtras,
  isNew,
  saving,
  onSave,
  onDiscard,
}: {
  draft: Route & Partial<RouteDto>;
  extras: Extras;
  setExtras: (next: Extras) => void;
  isNew: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const selectedPointIndex = useHouseStore((s) => s.selectedPointIndex);
  const index = useHouseStore((s) => s.index);
  const setRoutePoint = useHouseStore((s) => s.setRoutePoint);
  const insertRoutePoint = useHouseStore((s) => s.insertRoutePoint);
  const setRoutePointPlace = useHouseStore((s) => s.setRoutePointPlace);
  const deleteRoutePoint = useHouseStore((s) => s.deleteRoutePoint);
  const selectPoint = useHouseStore((s) => s.selectPoint);
  const catalog = useEndpoints();
  const currentPlace = routePointPlace(draft, draft.points.length - 1);
  const currentFloorId = currentPlace.floorId ?? index?.floorOrder[0] ?? null;
  const [targetFloorId, setTargetFloorId] = useState<FloorId | "">(
    index?.floorOrder.find((floorId) => floorId !== currentFloorId) ?? "",
  );

  const setAxis = (i: number, axis: 0 | 1 | 2, raw: string): void => {
    const value = Number(raw);
    const point = draft.points[i];
    if (!point || !Number.isFinite(value)) return;
    const next: Vec3 = [...point];
    next[axis] = value;
    setRoutePoint(i, next);
  };

  /** A new point half a metre past the last one, along the direction the run is already going. */
  const append = (): void => {
    const n = draft.points.length;
    const last = draft.points[n - 1];
    const previous = draft.points[n - 2];
    if (!last) return;
    let dx = previous ? last[0] - previous[0] : 0.5;
    let dz = previous ? last[2] - previous[2] : 0;
    let length = Math.hypot(dx, dz);
    if (length === 0) {
      dx = 0.5;
      dz = 0;
      length = 0.5;
    }
    insertRoutePoint(n, [last[0] + (dx / length) * 0.5, last[1], last[2] + (dz / length) * 0.5]);
    selectPoint(n);
  };

  const continueOnFloor = (): void => {
    if (!index || !targetFloorId || targetFloorId === currentFloorId) return;
    const last = draft.points.at(-1);
    if (!last) return;
    const currentBase = currentPlace.roomId
      ? index.rooms.get(currentPlace.roomId)?.floorElevation
      : currentPlace.floorId
        ? index.floors.get(currentPlace.floorId)?.elevation
        : undefined;
    const roomId = roomAt(index, targetFloorId, last[0], last[2]);
    const targetBase = roomId
      ? index.rooms.get(roomId)?.floorElevation
      : index.floors.get(targetFloorId)?.elevation;
    if (targetBase === undefined) return;
    const y = targetBase + (last[1] - (currentBase ?? last[1]));
    const riserIndex = draft.points.length;
    // Per-point place metadata preserves the destination even though this is the final vertex.
    insertRoutePoint(riserIndex, [last[0], y, last[2]], {
      floorId: targetFloorId,
      roomId,
    });
    selectPoint(riserIndex);
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/45 bg-surface-2 p-2">
      <p className="text-xs text-ink">
        Drawing <strong>{draft.name}</strong>
        {isNew ? " (not saved yet)" : " (editing a stored run)"} —{" "}
        {polylineLength(draft.points).toFixed(2)} m over {draft.points.length} points.
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-ink-2">Points (physical metres)</legend>
        <ul className="flex flex-col gap-1">
          {draft.points.map((point, i) => (
            <li
              key={i}
              className={
                selectedPointIndex === i
                  ? "rounded-md border border-accent/45 p-1"
                  : "rounded-md border border-transparent p-1"
              }
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => selectPoint(i)}
                  className="w-5 shrink-0 text-left text-[11px] text-ink-3"
                  aria-label={`Select point ${i + 1}`}
                >
                  {i + 1}
                </button>
                {([0, 1, 2] as const).map((axis) => (
                  <input
                    key={axis}
                    value={String(point[axis])}
                    onChange={(e) => setAxis(i, axis, e.target.value)}
                    inputMode="decimal"
                    aria-label={`Point ${i + 1} ${axis === 0 ? "x" : axis === 1 ? "y" : "z"} in metres`}
                    className={`${INPUT} w-full min-w-0`}
                  />
                ))}
                <button
                  type="button"
                  onClick={() =>
                    insertRoutePoint(i + 1, [point[0] + 0.25, point[1], point[2] + 0.25])
                  }
                  className="shrink-0 px-1 text-[11px] text-ink-2 underline"
                  aria-label={`Insert a point after point ${i + 1}`}
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => deleteRoutePoint(i)}
                  disabled={draft.points.length <= 2}
                  className="shrink-0 px-1 text-[11px] text-ink-2 underline disabled:opacity-40"
                  aria-label={`Delete point ${i + 1}`}
                >
                  −
                </button>
              </div>
              {index ? (
                <div className="mt-1 grid grid-cols-2 gap-1 pl-5">
                  <label className="flex flex-col gap-0.5 text-[10px] text-ink-3">
                    Point floor
                    <Select
                      selectSize="sm"
                      value={routePointPlace(draft, i).floorId ?? ""}
                      onValueChange={(value) =>
                        setRoutePointPlace(i, { floorId: value || null, roomId: null })
                      }
                      options={[
                        { value: "", label: "Site / unknown floor" },
                        ...index.floorOrder.map((floorId) => ({
                          value: floorId,
                          label: index.floors.get(floorId)?.name ?? floorId,
                        })),
                      ]}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 text-[10px] text-ink-3">
                    Room
                    <Select
                      selectSize="sm"
                      value={routePointPlace(draft, i).roomId ?? ""}
                      onValueChange={(value) =>
                        setRoutePointPlace(i, {
                          floorId: routePointPlace(draft, i).floorId,
                          roomId: value || null,
                        })
                      }
                      options={[
                        { value: "", label: "Not recorded" },
                        ...(routePointPlace(draft, i).floorId
                          ? (index.roomsByFloor.get(routePointPlace(draft, i).floorId!) ?? []).map((room) => ({
                              value: room.id,
                              label: room.name,
                            }))
                          : []),
                      ]}
                    />
                  </label>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button type="button" className={BUTTON} onClick={append}>
            Add a point at the end
          </button>
        </div>
        {index && index.floorOrder.length > 1 ? (
          <div className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-md border border-line bg-surface p-2">
            <label className="flex flex-col gap-1 text-xs text-ink-2">
              Continue on another floor
              <Select
                selectSize="sm"
                value={targetFloorId}
                onValueChange={(value) => setTargetFloorId(value as FloorId)}
                options={index.floorOrder.map((floorId) => ({
                  value: floorId,
                  label: index.floors.get(floorId)?.name ?? floorId,
                }))}
              />
            </label>
            <button
              type="button"
              className={BUTTON}
              disabled={!targetFloorId || targetFloorId === currentFloorId}
              onClick={continueOnFloor}
            >
              Add vertical riser
            </button>
          </div>
        ) : null}
        <p className="text-[11px] text-ink-3">
          A run needs at least two points, so the last two cannot be deleted. x and z are also
          draggable on the plan below; y is the height above the site datum.
        </p>
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-ink-2">Runs from</span>
          <Select
            selectSize="sm"
            value={extras.fromEndpointId}
            onValueChange={(value) => setExtras({ ...extras, fromEndpointId: value })}
            options={[
              { value: "", label: "Not recorded" },
              ...catalog.endpoints.map((endpoint) => ({
                value: endpoint.id,
                label: `${endpoint.name} (${ENDPOINT_KIND_SHORT[endpoint.kind]})`,
              })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-ink-2">Runs to</span>
          <Select
            selectSize="sm"
            value={extras.toEndpointId}
            onValueChange={(value) => setExtras({ ...extras, toEndpointId: value })}
            options={[
              { value: "", label: "Not recorded" },
              ...catalog.endpoints.map((endpoint) => ({
                value: endpoint.id,
                label: `${endpoint.name} (${ENDPOINT_KIND_SHORT[endpoint.kind]})`,
              })),
            ]}
          />
        </label>
      </div>
      {catalog.endpoints.length === 0 ? (
        <p className="text-[11px] text-ink-3">
          No endpoints recorded yet — add the vent or the shutoff below and it becomes selectable
          here.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : "Save path"}
        </button>
        <button type="button" className={BUTTON} disabled={saving} onClick={onDiscard}>
          {isNew ? "Discard this run" : "Revert changes"}
        </button>
      </div>
      <p className="text-[11px] text-ink-3">
        Closing the path editor discards changes. Use <strong>Save path</strong> to store
        the polyline.
      </p>
    </div>
  );
}
