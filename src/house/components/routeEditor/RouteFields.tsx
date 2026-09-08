"use client";
/**
 * Everything about a route that is *not* its geometry: what it carries, how well it is known,
 * whether it exists yet, how deep it sits and which renovation put it there.
 *
 * The one non-negotiable piece of copy is the certainty legend. Geometry is drawn identically at
 * every confidence level — the dash pattern and opacity are the only difference — so a plausible
 * picture of a concealed pipe is easy to mistake for a survey. The words are the safeguard, and
 * they are not decoration.
 *
 * Saving is optimistic: the store is updated first (the scene follows it, so the line moves
 * immediately) and reverted to the previous route on failure, because a change that looks saved
 * and is not is worse than one that visibly snaps back.
 */
import { useEffect, useState } from "react";
import type { InfraCertainty, InfraLifecycle, InfraMedium } from "@/db/schema/infrastructure";
import { MEDIUM_LABELS, kindOfMedium, systemOfMedium } from "@/features/projects/infraMedium";
import { isRunVisibleOn, runVisibilityReason } from "@/features/projects/renovationDate";
import { NotPersistedError, type ProjectOption, type RouteSave } from "@/house/store/dataApi";
// The enum *values* come from the client-safe mirrors in `wire`, never from the drizzle schema.
import { CERTAINTIES, LIFECYCLES, MEDIA, type RouteDto } from "@/features/projects/wire";
import { ENDPOINT_KIND_SHORT } from "@/features/projects/infraEndpoint";
import type { Route, RouteId } from "@/house/model/types";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { useEndpoints } from "./useEndpoints";

/**
 * The legend, spelled out. Referenced by name from the tests so it cannot be quietly softened.
 */
export const CERTAINTY_LEGEND =
  "Line position is drawn; confidence is shown by style. A precise-looking line is not proof of a verified concealed installation.";

const CERTAINTY_HELP: Record<InfraCertainty, string> = {
  measured: "Opened up, measured, and the measurement written down.",
  observed: "Seen — through a hatch, in a photo, on a drawing that matched.",
  inferred: "Worked out from where it has to go. Drawn dashed.",
  unknown: "Nobody knows. Drawn dashed and faint, with a question mark.",
};

const LIFECYCLE_HELP: Record<InfraLifecycle, string> = {
  planned: "Not there yet. Drawn hue-neutral so a plan never reads as an installation.",
  installed: "In the house now.",
  removed: "Gone. Only drawn when the renovation date reaches back past its removal.",
};

interface Draft {
  name: string;
  medium: InfraMedium;
  certainty: InfraCertainty;
  lifecycle: InfraLifecycle;
  nominalSize: string;
  diameterMm: string;
  installedAt: string;
  removedAt: string;
  depthM: string;
  offsetSurfaceId: string;
  offsetM: string;
  projectId: string;
  fromEndpointId: string;
  toEndpointId: string;
  note: string;
}

function draftOf(route: Route & Partial<RouteDto>): Draft {
  return {
    name: route.name,
    medium: route.medium ?? "cold_water",
    certainty: route.certainty,
    lifecycle: route.lifecycle,
    nominalSize: route.nominalSize ?? "",
    diameterMm: route.diameterM === undefined ? "" : String(Math.round(route.diameterM * 1000)),
    installedAt: route.installedAt ?? "",
    removedAt: route.removedAt ?? "",
    depthM: route.depthM === undefined ? "" : String(route.depthM),
    offsetSurfaceId: route.offsetFrom?.surfaceId ?? "",
    offsetM: route.offsetFrom === undefined ? "" : String(route.offsetFrom.offsetM),
    projectId: route.projectId ?? route.renovationId ?? "",
    fromEndpointId: route.fromEndpointId ?? "",
    toEndpointId: route.toEndpointId ?? "",
    note: route.note ?? "",
  };
}

export function RouteFields({ routeId }: { routeId: RouteId }) {
  const runtime = useHouseRuntime();
  const { routes, index, modelId, fingerprint, selection, renovationDate } = useHouseStore(
    useShallow((s) => ({
      routes: s.routes,
      index: s.index,
      modelId: s.modelId,
      fingerprint: s.fingerprint,
      selection: s.selection,
      renovationDate: s.renovationDate,
    })),
  );
  const upsertRoute = useHouseStore((s) => s.upsertRoute);
  const setDataError = useHouseStore((s) => s.setDataError);
  const endpointCatalog = useEndpoints();

  const route = routes.find((r) => r.id === routeId) as (Route & Partial<RouteDto>) | undefined;
  /**
   * The draft is *keyed* by route id rather than re-seeded from an effect. Selecting a different
   * route derives a fresh draft during the same render, with no cascading re-render and no window
   * in which the panel shows one route's fields over another route's data.
   */
  const [held, setHeld] = useState<{ routeId: RouteId; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [uploading, setUploading] = useState(false);

  const draft: Draft | null =
    held && held.routeId === routeId ? held.draft : route ? draftOf(route) : null;
  const setDraft = (next: Draft): void => setHeld({ routeId, draft: next });

  useEffect(() => {
    if (!modelId) return;
    let cancelled = false;
    void runtime.dataApi
      .listProjectOptions(modelId)
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        // A missing project list disables one picker; it must never break the inspector.
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, modelId]);

  if (!route || !draft || !index) return null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft({ ...draft, [key]: value });

  const selectedWall =
    selection?.kind === "surface" && index.surfaces.get(selection.id)?.kind === "wall"
      ? selection.id
      : null;

  const number = (raw: string): number | undefined => {
    if (raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const save = async (patch: Partial<Draft> = {}, photoIds?: string[]): Promise<void> => {
    if (!modelId || !fingerprint) return;
    const next = { ...draft, ...patch };
    const previous = route;
    const diameterMm = number(next.diameterMm);
    const offsetM = number(next.offsetM);

    const candidate: RouteSave = {
      ...route,
      name: next.name.trim() === "" ? route.name : next.name.trim(),
      medium: next.medium,
      system: systemOfMedium(next.medium),
      kind: kindOfMedium(next.medium),
      certainty: next.certainty,
      lifecycle: next.lifecycle,
      nominalSize: next.nominalSize.trim() === "" ? null : next.nominalSize.trim(),
      ...(diameterMm === undefined ? {} : { diameterM: diameterMm / 1000 }),
      ...(next.installedAt === "" ? {} : { installedAt: next.installedAt }),
      ...(next.removedAt === "" ? {} : { removedAt: next.removedAt }),
      ...(number(next.depthM) === undefined ? {} : { depthM: number(next.depthM) }),
      ...(next.offsetSurfaceId !== "" && offsetM !== undefined
        ? {
            offsetFrom: {
              surfaceId: next.offsetSurfaceId,
              kind: "wall" as const,
              offsetM,
            },
          }
        : {}),
      projectId: next.projectId === "" ? null : next.projectId,
      fromEndpointId: next.fromEndpointId === "" ? null : next.fromEndpointId,
      toEndpointId: next.toEndpointId === "" ? null : next.toEndpointId,
      note: next.note.trim() === "" ? undefined : next.note.trim(),
      photoIds: photoIds ?? route.photoIds,
    };

    setSaving(true);
    setError(null);
    // Optimistic: the scene reads the store, so the change is visible before the round trip.
    upsertRoute(candidate);
    try {
      const saved = await runtime.dataApi.saveRoute(modelId, fingerprint, candidate);
      upsertRoute(saved);
      setDraft(draftOf(saved as Route & Partial<RouteDto>));
    } catch (err) {
      upsertRoute(previous);
      if (err instanceof NotPersistedError) {
        setDataError(
          `Routes are not stored yet (${err.reason}) — this change lasts for the session only.`,
        );
      } else {
        setError(err instanceof Error ? err.message : "The change was not saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  const uploadPhoto = async (file: File): Promise<void> => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError(`The photo was not uploaded (${res.status}). Nothing was attached.`);
        return;
      }
      const stored = (await res.json()) as { id: string };
      await save({}, [...route.photoIds, stored.id]);
    } catch {
      setError("The upload did not reach the server. Nothing was attached.");
    } finally {
      setUploading(false);
    }
  };

  const visible = isRunVisibleOn(route, renovationDate);

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
        Route details
      </h3>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-ink-2">Name</span>
        <input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          onBlur={() => void save()}
          maxLength={200}
          className="min-h-8 rounded-md border border-line px-2 text-xs"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-ink-2">Carries</span>
          <select
            value={draft.medium}
            onChange={(e) => {
              const medium = e.target.value as InfraMedium;
              set("medium", medium);
              void save({ medium });
            }}
            className="min-h-8 rounded-md border border-line px-1 text-xs"
          >
            {MEDIA.map((m) => (
              <option key={m} value={m}>
                {MEDIUM_LABELS[m]}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-ink-3">
            Drawn as a {kindOfMedium(draft.medium)} in the {systemOfMedium(draft.medium)} system.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-ink-2">Size</span>
          <input
            value={draft.nominalSize}
            onChange={(e) => set("nominalSize", e.target.value)}
            onBlur={() => void save()}
            placeholder="DN20, Cat6a"
            maxLength={60}
            className="min-h-8 rounded-md border border-line px-2 text-xs"
          />
          <input
            value={draft.diameterMm}
            onChange={(e) => set("diameterMm", e.target.value)}
            onBlur={() => void save()}
            inputMode="numeric"
            placeholder="Diameter in mm"
            className="min-h-8 rounded-md border border-line px-2 text-xs"
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-ink-2">Confidence</legend>
        <select
          value={draft.certainty}
          onChange={(e) => {
            const certainty = e.target.value as InfraCertainty;
            set("certainty", certainty);
            void save({ certainty });
          }}
          className="min-h-8 rounded-md border border-line px-1 text-xs"
        >
          {CERTAINTIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-ink-2">{CERTAINTY_HELP[draft.certainty]}</p>
        <p className="rounded-md border border-line bg-surface-2 p-2 text-[11px] text-ink-2">
          {CERTAINTY_LEGEND}
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-ink-2">Lifecycle</legend>
        <select
          value={draft.lifecycle}
          onChange={(e) => {
            const lifecycle = e.target.value as InfraLifecycle;
            set("lifecycle", lifecycle);
            void save({ lifecycle });
          }}
          className="min-h-8 rounded-md border border-line px-1 text-xs"
        >
          {LIFECYCLES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-ink-2">{LIFECYCLE_HELP[draft.lifecycle]}</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">Installed on</span>
            <input
              type="date"
              value={draft.installedAt}
              onChange={(e) => set("installedAt", e.target.value)}
              onBlur={() => void save()}
              className="min-h-8 rounded-md border border-line px-2 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">Removed on</span>
            <input
              type="date"
              value={draft.removedAt}
              onChange={(e) => set("removedAt", e.target.value)}
              onBlur={() => void save()}
              disabled={draft.lifecycle === "planned"}
              className="min-h-8 rounded-md border border-line px-2 text-xs disabled:bg-surface-2"
            />
          </label>
        </div>
        <p className="text-[11px] text-ink-3">
          {runVisibilityReason(route, renovationDate)}
          {visible ? "" : " Not drawn under the current renovation date filter."}
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-ink-2">Depth and offset</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">Depth into structure (m)</span>
            <input
              value={draft.depthM}
              onChange={(e) => set("depthM", e.target.value)}
              onBlur={() => void save()}
              inputMode="decimal"
              placeholder="-0.04"
              className="min-h-8 rounded-md border border-line px-2 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">Offset from surface (m)</span>
            <input
              value={draft.offsetM}
              onChange={(e) => set("offsetM", e.target.value)}
              onBlur={() => void save()}
              inputMode="decimal"
              className="min-h-8 rounded-md border border-line px-2 text-xs"
            />
          </label>
        </div>
        <p className="text-[11px] text-ink-3">
          Negative depth means behind the visible face.
        </p>
        {draft.offsetSurfaceId ? (
          <p className="text-[11px] text-ink-2">
            Measured from <code>{draft.offsetSurfaceId}</code>{" "}
            <button
              type="button"
              onClick={() => {
                set("offsetSurfaceId", "");
                void save({ offsetSurfaceId: "" });
              }}
              className="underline"
            >
              clear
            </button>
          </p>
        ) : (
          <p className="text-[11px] text-ink-3">No reference surface.</p>
        )}
        <button
          type="button"
          disabled={!selectedWall}
          onClick={() => {
            if (!selectedWall) return;
            set("offsetSurfaceId", selectedWall);
            void save({ offsetSurfaceId: selectedWall });
          }}
          className="self-start min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
        >
          {selectedWall ? `Use selected wall (${selectedWall})` : "Select a wall surface first"}
        </button>
      </fieldset>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-ink-2">Renovation project</span>
        <select
          value={draft.projectId}
          onChange={(e) => {
            const projectId = e.target.value;
            set("projectId", projectId);
            void save({ projectId });
          }}
          className="min-h-8 rounded-md border border-line px-1 text-xs"
        >
          <option value="">Not attributed</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.status})
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-ink-2">Runs between</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["fromEndpointId", "toEndpointId"] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-xs">
              <span className="text-ink-2">{field === "fromEndpointId" ? "From" : "To"}</span>
              <select
                value={draft[field]}
                onChange={(e) => {
                  const value = e.target.value;
                  set(field, value);
                  void save(
                    field === "fromEndpointId"
                      ? { fromEndpointId: value }
                      : { toEndpointId: value },
                  );
                }}
                className="min-h-8 rounded-md border border-line px-1 text-xs"
              >
                <option value="">Not recorded</option>
                {endpointCatalog.endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>
                    {endpoint.name} ({ENDPOINT_KIND_SHORT[endpoint.kind]})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-ink-3">
          The fixed things at each end — a manifold, a vent, a shutoff. Recording them is what makes
          &ldquo;where do I turn this off&rdquo; answerable from the run itself.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-ink-2">Photos</legend>
        {route.photoIds.length === 0 ? (
          <p className="text-[11px] text-ink-3">
            None. A photo of the open wall is the most durable record there is.
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {route.photoIds.map((photoId) => (
              <li key={photoId} className="flex flex-col gap-1">
                <a
                  href={`/api/attachments/${photoId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-md border border-line"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- private authed route */}
                  <img
                    src={`/api/attachments/${photoId}?v=thumb`}
                    alt="Route photo"
                    className="aspect-square w-full object-cover"
                  />
                </a>
                <button
                  type="button"
                  onClick={() =>
                    void save({}, route.photoIds.filter((id) => id !== photoId))
                  }
                  className="text-[11px] text-ink-2 underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          type="file"
          accept="image/*"
          disabled={uploading || saving}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadPhoto(file);
            event.target.value = "";
          }}
          className="text-xs"
        />
      </fieldset>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-ink-2">Note</span>
        <textarea
          value={draft.note}
          onChange={(e) => set("note", e.target.value)}
          onBlur={() => void save()}
          rows={3}
          maxLength={4000}
          className="rounded-md border border-line p-2 text-xs"
        />
      </label>

      <p className="text-[11px] text-ink-3" role="status">
        {saving ? "Saving…" : uploading ? "Uploading…" : "Changes save when a field loses focus."}
      </p>
      {error ? (
        <p role="alert" className="text-[11px] text-overdue">
          {error}
        </p>
      ) : null}
    </section>
  );
}
