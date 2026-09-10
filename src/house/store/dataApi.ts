/**
 * `HouseDataApi` — the persistence seam for everything the workspace can change.
 *
 * The workspace never talks to the database. It talks to this interface, so the same components
 * work against an in-memory implementation (tests, and the workspace's own fallback when the
 * server has nowhere to put the data yet) and against the REST client below.
 *
 * Persistence rules baked in here (CLAUDE.md rule 7):
 *  - coordinates are **physical** site metres, never exploded/cutaway presentation values;
 *  - every write carries `{ modelId, fingerprint }` so a package swap is detectable;
 *  - colouring writes a colour and nothing else — no geometry, ever.
 */
import type { AnnotationDto, EndpointDto, EndpointWrite, RouteDto } from "@/features/projects/wire";
import { mediumForSystem } from "@/features/projects/infraMedium";
import type { Placement, Route, SurfaceId } from "@/house/model/types";
import type { HouseLabelPreferences } from "@/house/model/labelPreferences";
import { routePointPlace } from "@/house/model/routePlaces";

export interface ColorOverrideWrite {
  surfaceId: SurfaceId;
  roomId?: string | null;
  /** `null` deletes the override, which restores the manifest's `defaultColor`. */
  colorHex: string | null;
}

/**
 * A route on its way to the server. The workspace's own `Route` is enough — the server derives the
 * medium from `system`, keeping the row's existing one where it still fits — and the extra
 * persisted facts are optional, for the inspector, which does know them.
 */
export type RouteSave = Route &
  Partial<
    Pick<
      RouteDto,
      | "medium"
      | "nominalSize"
      | "systemId"
      | "isEstimated"
      | "projectId"
      | "fromEndpointId"
      | "toEndpointId"
      | "pointKinds"
    >
  >;

export interface ProjectOption {
  id: string;
  name: string;
  status: string;
}

/** An annotation on its way to the server: the stored shape, minus the server's own fields. */
export type AnnotationSave = Omit<AnnotationDto, "id" | "needsReconciliation" | "photoIds"> & {
  /** Absent = a new pin. */
  id?: string;
};

/**
 * Equipment that exists but has no position in this model yet. The workspace needs it to offer
 * "place this" at all: `placements` only ever contains things already placed, so a freshly
 * imported device would be invisible everywhere.
 */
export interface PlaceableEquipment {
  assetId: string;
  name: string;
  category: string;
  status: string;
  locationName: string | null;
}

export interface LabelPreferenceWrite {
  nodeId: string;
  /** `null` restores the confirmed HA/location/model fallback. */
  displayName: string | null;
  /** `null` restores the semantic default. */
  visible: boolean | null;
}

export interface HouseDataApi {
  listLabelPreferences(modelId: string): Promise<HouseLabelPreferences>;
  saveLabelPreference(
    modelId: string,
    fingerprint: string,
    write: LabelPreferenceWrite,
  ): Promise<HouseLabelPreferences>;

  listColorOverrides(modelId: string): Promise<Record<SurfaceId, string>>;
  saveColorOverrides(
    modelId: string,
    fingerprint: string,
    writes: readonly ColorOverrideWrite[],
  ): Promise<Record<SurfaceId, string>>;

  listPlacements(modelId: string): Promise<Placement[]>;
  savePlacement(modelId: string, fingerprint: string, placement: Placement): Promise<Placement>;
  deletePlacement(modelId: string, placementId: string): Promise<void>;

  listRoutes(modelId: string): Promise<Route[]>;
  saveRoute(modelId: string, fingerprint: string, route: RouteSave): Promise<Route>;
  /** Soft by default: the run becomes `removed` and keeps its history. `hard` erases a mistake. */
  deleteRoute(modelId: string, routeId: string, opts?: { hard?: boolean }): Promise<void>;

  listEndpoints(modelId: string): Promise<EndpointDto[]>;
  saveEndpoint(modelId: string, fingerprint: string, endpoint: EndpointWrite): Promise<EndpointDto>;
  deleteEndpoint(modelId: string, endpointId: string): Promise<void>;

  /**
   * The projects a route may be attributed to, for the inspector's picker. Served by the routes
   * resource (`?options=projects`), because it only ever fills in a field of a route.
   */
  listProjectOptions(modelId: string): Promise<ProjectOption[]>;

  /** Equipment with no coordinates in this model yet, so the workspace can offer to place it. */
  listPlaceableEquipment(modelId: string): Promise<PlaceableEquipment[]>;

  listAnnotations(modelId: string): Promise<AnnotationDto[]>;
  saveAnnotation(
    modelId: string,
    fingerprint: string,
    annotation: AnnotationSave,
  ): Promise<AnnotationDto>;
  deleteAnnotation(modelId: string, annotationId: string): Promise<void>;
}

/**
 * Refusals this layer can say something useful about. Anything not listed falls back to the
 * endpoint's own `error` code, which is at least a name rather than an HTTP verb and a number.
 */
const REQUEST_ERRORS: Record<string, string> = {
  equipment_not_current: "This equipment is no longer available to place. Reload the house view to refresh the equipment list.",
  mount_surface_kind_mismatch: "That surface cannot take this kind of mount",
  unknown_surface: "The model does not have that surface any more",
  unknown_label_node: "The model does not have that room or floor any more",
  unknown_room: "The model does not have that room any more",
  unknown_floor: "The model does not have that floor any more",
  room_floor_mismatch: "That room is not on this floor",
  unknown_attachment: "That photo is not in this household's files",
  presentation_view_mode: "Leave the exploded or cutaway view before saving a position",
  fingerprint_mismatch: "The model package changed while this was open — reload the house view",
};

/** Thrown when the server has no place to put the data yet; the caller keeps it in the store. */
export class NotPersistedError extends Error {
  constructor(readonly reason: string) {
    super(`not persisted: ${reason}`);
    this.name = "NotPersistedError";
  }
}

// ---------------------------------------------------------------------------
// in-memory
// ---------------------------------------------------------------------------

/**
 * Session-scoped implementation. Deliberately **not** `localStorage`: a half-saved placement that
 * survives a reload but exists nowhere on the server is worse than one that is plainly lost.
 */
export function createMemoryDataApi(
  seed: {
    overrides?: Record<SurfaceId, string>;
    placements?: Placement[];
    routes?: Route[];
    endpoints?: EndpointDto[];
    annotations?: AnnotationDto[];
    projectOptions?: ProjectOption[];
    placeableEquipment?: PlaceableEquipment[];
    labelPreferences?: HouseLabelPreferences;
  } = {},
): HouseDataApi {
  const overrides = new Map<SurfaceId, string>(Object.entries(seed.overrides ?? {}));
  const placements = new Map<string, Placement>((seed.placements ?? []).map((p) => [p.id, p]));
  const routes = new Map<string, Route>((seed.routes ?? []).map((r) => [r.id, r]));
  const endpoints = new Map<string, EndpointDto>((seed.endpoints ?? []).map((e) => [e.id, e]));
  const annotations = new Map<string, AnnotationDto>((seed.annotations ?? []).map((a) => [a.id, a]));
  let counter = 0;
  let labelPreferences = seed.labelPreferences ?? {
    names: {},
    visibility: {},
    customNames: {},
    customVisibility: {},
  };
  const localId = (prefix: string): string => `${prefix}-local-${++counter}`;

  return {
    async listLabelPreferences() {
      return labelPreferences;
    },
    async saveLabelPreference(_modelId, _fingerprint, write) {
      const customNames = { ...labelPreferences.customNames };
      const customVisibility = { ...labelPreferences.customVisibility };
      const names = { ...labelPreferences.names };
      const visibility = { ...labelPreferences.visibility };
      if (write.displayName === null) {
        delete customNames[write.nodeId];
        delete names[write.nodeId];
      }
      else {
        customNames[write.nodeId] = write.displayName;
        names[write.nodeId] = write.displayName;
      }
      if (write.visible === null) {
        delete customVisibility[write.nodeId];
        delete visibility[write.nodeId];
      }
      else {
        customVisibility[write.nodeId] = write.visible;
        visibility[write.nodeId] = write.visible;
      }
      labelPreferences = { names, visibility, customNames, customVisibility };
      return labelPreferences;
    },
    async listColorOverrides() {
      return Object.fromEntries(overrides);
    },
    async saveColorOverrides(_modelId, _fingerprint, writes) {
      for (const w of writes) {
        if (w.colorHex === null) overrides.delete(w.surfaceId);
        else overrides.set(w.surfaceId, w.colorHex);
      }
      return Object.fromEntries(overrides);
    },
    async listPlacements() {
      return [...placements.values()];
    },
    async savePlacement(_modelId, _fingerprint, placement) {
      placements.set(placement.id, placement);
      return placement;
    },
    async deletePlacement(_modelId, placementId) {
      placements.delete(placementId);
    },
    async listRoutes() {
      return [...routes.values()];
    },
    async saveRoute(_modelId, _fingerprint, route) {
      routes.set(route.id, route);
      return route;
    },
    async deleteRoute(_modelId, routeId, opts) {
      // Mirrors the server's semantics, so the UI behaves identically either way.
      const route = routes.get(routeId);
      if (!opts?.hard && route) routes.set(routeId, { ...route, lifecycle: "removed" });
      else routes.delete(routeId);
    },
    async listEndpoints() {
      return [...endpoints.values()];
    },
    async saveEndpoint(_modelId, _fingerprint, endpoint) {
      const id = endpoint.id ?? localId("endpoint");
      const stored: EndpointDto = {
        id,
        name: endpoint.name,
        kind: endpoint.kind,
        locationId: endpoint.locationId ?? null,
        assetId: endpoint.assetId ?? null,
        modelNodeId: endpoint.modelNodeId ?? null,
        position: endpoint.position ?? null,
        notes: endpoint.notes ?? null,
        needsReconciliation: false,
      };
      endpoints.set(id, stored);
      return stored;
    },
    async deleteEndpoint(_modelId, endpointId) {
      endpoints.delete(endpointId);
    },
    async listProjectOptions() {
      return seed.projectOptions ?? [];
    },
    async listPlaceableEquipment() {
      return seed.placeableEquipment ?? [];
    },
    async listAnnotations() {
      return [...annotations.values()];
    },
    async saveAnnotation(_modelId, _fingerprint, input) {
      const id = input.id ?? localId("annotation");
      const stored: AnnotationDto = {
        ...input,
        id,
        needsReconciliation: false,
        photoIds: annotations.get(id)?.photoIds ?? [],
      };
      annotations.set(id, stored);
      return stored;
    },
    async deleteAnnotation(_modelId, annotationId) {
      annotations.delete(annotationId);
    },
  };
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export interface RestDataApiOptions {
  /** Defaults to `/api`. */
  base?: string;
  fetchImpl?: typeof fetch;
}

/**
 * REST client.
 *
 * Every method here has a server-side endpoint: `colors`, `placements`, `routes`, `endpoints` and
 * `annotations`, all under `/api/house-model/<modelId>/`. Infrastructure routes used to raise
 * `NotPersistedError` unconditionally; they are persisted now, and `docs/model-contract.md` §3
 * records the change.
 *
 * Every write that carries a coordinate also carries `viewMode: "normal"`: the endpoint rejects
 * anything else with a 422, because a coordinate read in an exploded or cutaway view is a
 * presentation value and must never be stored (CLAUDE.md rule 7). The client cannot fake this —
 * edit mode collapses and locks the exploded view, and the save path reads the draft's physical
 * triple.
 *
 * A `409` still becomes a `NotPersistedError`, which is how "the model package has not been
 * imported yet" (`model_revision_missing`) degrades to the session store with the UI saying so,
 * instead of losing the user's work.
 */
export function createRestDataApi(opts: RestDataApiOptions = {}): HouseDataApi {
  const base = opts.base ?? "/api";
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (res.status === 404 || res.status === 501) throw new NotPersistedError(`endpoint ${path}`);
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new NotPersistedError(body.error ?? "conflict");
    }
    if (!res.ok) {
      // The endpoint answers `{error, hint}` for every refusal it can explain (an unknown surface,
      // a mount kind the surface cannot take, a coordinate outside the model). Throwing the status
      // line instead put `PUT /house-model/…/placements → 400` in front of the household, which
      // says nothing about what to change.
      const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
      const detail = [body.error && (REQUEST_ERRORS[body.error] ?? body.error), body.hint]
        .filter(Boolean)
        .join(" — ");
      throw new Error(detail || `${init?.method ?? "GET"} ${path} → ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const model = (modelId: string) => `/house-model/${encodeURIComponent(modelId)}`;

  return {
    async listLabelPreferences(modelId) {
      return request<HouseLabelPreferences>(`${model(modelId)}/labels`);
    },

    async saveLabelPreference(modelId, fingerprint, write) {
      return request<HouseLabelPreferences>(`${model(modelId)}/labels`, {
        method: "PATCH",
        body: JSON.stringify({ fingerprint, write }),
      });
    },

    async listColorOverrides(modelId) {
      const body = await request<{ overrides: Record<SurfaceId, string> }>(`${model(modelId)}/colors`);
      return body.overrides ?? {};
    },

    async saveColorOverrides(modelId, fingerprint, writes) {
      const body = await request<{ overrides: Record<SurfaceId, string> }>(
        `${model(modelId)}/colors`,
        { method: "PATCH", body: JSON.stringify({ fingerprint, writes }) },
      );
      return body.overrides ?? {};
    },

    async listPlacements(modelId) {
      const body = await request<{ placements: Placement[] }>(`${model(modelId)}/placements`);
      return body.placements ?? [];
    },

    async savePlacement(modelId, fingerprint, placement) {
      const body = await request<{ placement: Placement }>(`${model(modelId)}/placements`, {
        method: "PUT",
        body: JSON.stringify({
          fingerprint,
          // Asserted, not inferred: the caller is stating these are physical site coordinates.
          viewMode: "normal",
          placement: {
            id: placement.id,
            equipmentId: placement.equipmentId,
            position: placement.position,
            rotationYDeg: placement.rotationYDeg,
            lightAim: placement.lightAim ?? null,
            ledLengthM: placement.ledLengthM,
            detectionRangeM: placement.detectionRangeM,
            treeHeightM: placement.treeHeightM,
            equipmentSize: placement.equipmentSize,
            solarPanel: placement.solarPanel ?? null,
            floorId: placement.floorId,
            roomId: placement.roomId,
            // The mount round-trips now: a wall-mounted sensor keeps *which* wall it is on.
            mount: placement.mount,
            locationNote: placement.locationNote || null,
            photoId: placement.photoId,
            symbol: placement.symbol,
          },
        }),
      });
      return body.placement ?? placement;
    },

    async deletePlacement(modelId, placementId) {
      await request<void>(
        `${model(modelId)}/placements/${encodeURIComponent(placementId)}`,
        { method: "DELETE" },
      );
    },

    async listRoutes(modelId) {
      const body = await request<{ routes: RouteDto[] }>(`${model(modelId)}/routes`);
      return body.routes ?? [];
    },

    async saveRoute(modelId, fingerprint, route) {
      const body = await request<{ route: RouteDto }>(`${model(modelId)}/routes`, {
        method: "PUT",
        body: JSON.stringify({ fingerprint, viewMode: "normal", route: routeWrite(route) }),
      });
      return body.route ?? route;
    },

    async deleteRoute(modelId, routeId, deleteOpts) {
      const query = deleteOpts?.hard ? "?hard=1" : "";
      await request<unknown>(`${model(modelId)}/routes/${encodeURIComponent(routeId)}${query}`, {
        method: "DELETE",
      });
    },

    async listEndpoints(modelId) {
      const body = await request<{ endpoints: EndpointDto[] }>(`${model(modelId)}/endpoints`);
      return body.endpoints ?? [];
    },

    async saveEndpoint(modelId, fingerprint, endpoint) {
      const body = await request<{ endpoint: EndpointDto }>(`${model(modelId)}/endpoints`, {
        method: "PUT",
        body: JSON.stringify({ fingerprint, viewMode: "normal", endpoint }),
      });
      return body.endpoint;
    },

    async deleteEndpoint(modelId, endpointId) {
      await request<void>(`${model(modelId)}/endpoints?id=${encodeURIComponent(endpointId)}`, {
        method: "DELETE",
      });
    },

    async listProjectOptions(modelId) {
      const body = await request<{ projects: ProjectOption[] }>(
        `${model(modelId)}/routes?options=projects`,
      );
      return body.projects ?? [];
    },

    async listPlaceableEquipment(modelId) {
      const body = await request<{ placeable: PlaceableEquipment[] }>(
        `${model(modelId)}/placements?options=placeable`,
      );
      return body.placeable ?? [];
    },

    async listAnnotations(modelId) {
      const body = await request<{ annotations: AnnotationDto[] }>(`${model(modelId)}/annotations`);
      return body.annotations ?? [];
    },

    async saveAnnotation(modelId, fingerprint, annotation) {
      const body = await request<{ annotation: AnnotationDto }>(`${model(modelId)}/annotations`, {
        method: "PUT",
        body: JSON.stringify({ fingerprint, viewMode: "normal", annotation }),
      });
      return body.annotation;
    },

    async deleteAnnotation(modelId, annotationId) {
      await request<void>(`${model(modelId)}/annotations?id=${encodeURIComponent(annotationId)}`, {
        method: "DELETE",
      });
    },
  };
}

/**
 * `Route` (what the 3D view holds) → the endpoint's write shape.
 *
 * Two translations happen here, both documented under `src/features/projects/`:
 *  - `system` → `medium`, keeping an explicit medium when the caller has one, so re-saving a hot
 *    water run from the workspace does not turn it into cold water;
 *  - per-point floor/room reaches `infra_route_point` unchanged, including a riser's destination.
 *    Legacy in-memory drafts without point places inherit the outgoing span's place.
 */
export function routeWrite(route: RouteSave): Record<string, unknown> {
  const points = route.points.map((position, i) => {
    const place = routePointPlace(route, i);
    return {
      position,
      pointKind: route.pointKinds?.[i] ?? "vertex",
      floorId: place.floorId,
      roomId: place.roomId,
    };
  });

  return {
    id: route.id,
    name: route.name,
    system: route.system,
    medium: route.medium ?? mediumForSystem(route.system, null),
    systemId: route.systemId ?? null,
    nominalSize: route.nominalSize ?? null,
    diameterM: route.diameterM ?? null,
    widthM: route.widthM ?? null,
    certainty: route.certainty,
    lifecycle: route.lifecycle,
    isEstimated: route.isEstimated ?? route.certainty !== "measured",
    installedOn: route.installedAt ?? null,
    removedOn: route.removedAt ?? null,
    depthM: route.depthM ?? null,
    offsetSurfaceId: route.offsetFrom?.surfaceId ?? null,
    offsetM: route.offsetFrom?.offsetM ?? null,
    projectId: route.projectId ?? route.renovationId ?? null,
    notes: route.note ?? null,
    points,
    fromEndpointId: route.fromEndpointId ?? null,
    toEndpointId: route.toEndpointId ?? null,
    photoAttachmentIds: route.photoIds ?? [],
  };
}

/** Falls back to the in-memory store whenever the server has nowhere to persist yet. */
export function createResilientDataApi(
  remote: HouseDataApi,
  local: HouseDataApi,
  onFallback?: (reason: string) => void,
): HouseDataApi {
  const wrap = <A extends unknown[], R>(
    remoteFn: (...args: A) => Promise<R>,
    localFn: (...args: A) => Promise<R>,
  ) =>
    async (...args: A): Promise<R> => {
      try {
        return await remoteFn(...args);
      } catch (err) {
        if (err instanceof NotPersistedError) {
          onFallback?.(err.reason);
          return localFn(...args);
        }
        throw err;
      }
    };

  return {
    listLabelPreferences: wrap(
      remote.listLabelPreferences.bind(remote),
      local.listLabelPreferences.bind(local),
    ),
    saveLabelPreference: wrap(
      remote.saveLabelPreference.bind(remote),
      local.saveLabelPreference.bind(local),
    ),
    listColorOverrides: wrap(
      remote.listColorOverrides.bind(remote),
      local.listColorOverrides.bind(local),
    ),
    saveColorOverrides: wrap(
      remote.saveColorOverrides.bind(remote),
      local.saveColorOverrides.bind(local),
    ),
    listPlacements: wrap(remote.listPlacements.bind(remote), local.listPlacements.bind(local)),
    savePlacement: wrap(remote.savePlacement.bind(remote), local.savePlacement.bind(local)),
    deletePlacement: wrap(remote.deletePlacement.bind(remote), local.deletePlacement.bind(local)),
    listRoutes: wrap(remote.listRoutes.bind(remote), local.listRoutes.bind(local)),
    saveRoute: wrap(remote.saveRoute.bind(remote), local.saveRoute.bind(local)),
    deleteRoute: wrap(remote.deleteRoute.bind(remote), local.deleteRoute.bind(local)),
    listEndpoints: wrap(remote.listEndpoints.bind(remote), local.listEndpoints.bind(local)),
    saveEndpoint: wrap(remote.saveEndpoint.bind(remote), local.saveEndpoint.bind(local)),
    deleteEndpoint: wrap(remote.deleteEndpoint.bind(remote), local.deleteEndpoint.bind(local)),
    listProjectOptions: wrap(
      remote.listProjectOptions.bind(remote),
      local.listProjectOptions.bind(local),
    ),
    listPlaceableEquipment: wrap(
      remote.listPlaceableEquipment.bind(remote),
      local.listPlaceableEquipment.bind(local),
    ),
    listAnnotations: wrap(remote.listAnnotations.bind(remote), local.listAnnotations.bind(local)),
    saveAnnotation: wrap(remote.saveAnnotation.bind(remote), local.saveAnnotation.bind(local)),
    deleteAnnotation: wrap(
      remote.deleteAnnotation.bind(remote),
      local.deleteAnnotation.bind(local),
    ),
  };
}
