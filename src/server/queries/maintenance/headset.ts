import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset, assetConsumable, assetPlacement, attachment, attachmentLink, completion, completionMaterial,
  infraEndpoint, infraRoute, location, maintenanceOccurrence, maintenancePlan, modelRevision,
  part, serviceProvider, system, systemAsset,
} from "@/db/schema";
import { availableMilli } from "@/domain/inventory";
import { roomAt, type ManifestIndex } from "@/house/model/manifestIndex";
import type { Vec3 } from "@/house/model/types";
import type {
  HeadsetFindInput, HeadsetIllustration, HeadsetLocateTarget, HeadsetMaintenanceOverview, HeadsetMaintenanceTask,
  HeadsetSearchPage, HeadsetTaskRow,
} from "@/house/xr/headsetTasksTypes";
import { notFound } from "@/server/api/handler";
import { loadFrozenProcedure, loadMaterialLines, loadProgress, loadTaskPhotos } from "./task";

const REMOVABLE_MEDIA = ["cold_water", "hot_water"] as const;
const WATER_WORDS = /\b(water|vesi|vesi\w*|vand|agua|wasser)\b/;
const VALVE_WORDS = /\b(shut ?off|stop ?cock|isolation valve|sulku\w*|paasulku\w*)\b/;
const VENT_WORDS = /\b(ventilat\w*|air handling|air exchange|hrv|erv|ilmanvaihto\w*|iv kone|lto|air register|vallox|swegon casa)\b/;
const AIR_HANDLER_WORDS = /\b(air handling unit|air handler|ahu|ventilation (?:unit|machine)|heat recovery ventilator|energy recovery ventilator|ilmanvaihtokone|iv kone)\b/;
const FILTER_WORDS = /\b(filter\w*|suodatin\w*|suodattim\w*)\b/;
const FILTER_REPLACEMENT_WORDS = /\b(chang\w*|replac\w*|vaih\w*|vaiht\w*)\b/;
const PANEL_WORDS = /\b(electrical panel|breaker panel|consumer unit|sahkokeskus|ryhmakeskus|fuse box)\b/;
const PAGE_SIZE = 24;

function words(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const installedAsset = and(eq(asset.status, "installed"), eq(asset.isVirtual, false), isNull(asset.replacedByAssetId));
const openOccurrence = inArray(maintenanceOccurrence.status, ["due", "pending"]);
const currentModel = (modelId: string) => and(eq(modelRevision.modelId, modelId), eq(modelRevision.status, "current"));

type Body = typeof assetPlacement.$inferSelect;
type Endpoint = typeof infraEndpoint.$inferSelect;

function placeFields(index: ManifestIndex, nodeId: string | null, coordinates: { posX: number | null; posY: number | null; posZ: number | null } | null) {
  let room = nodeId === null ? undefined : index.rooms.get(nodeId);
  const floor = room?.floorId ?? (nodeId && index.floors.has(nodeId) ? nodeId : null);
  const bounds = index.manifest.bounds;
  const point = coordinates && [coordinates.posX, coordinates.posY, coordinates.posZ];
  const position = point && point.every((value, axis) => value !== null && Number.isFinite(value) &&
    value >= bounds.min[axis]! && value <= bounds.max[axis]!) ? point as Vec3 : null;
  if (!room && floor && position) room = index.rooms.get(roomAt(index, floor, position[0], position[2]) ?? "");
  return {
    roomId: room?.id ?? null, floorId: floor, roomName: room?.name ?? null,
    floorName: floor ? index.floors.get(floor)?.name ?? null : null, position: floor ? position : null,
  };
}

function makeEquipmentTarget(index: ManifestIndex, equipment: typeof asset.$inferSelect, body: Body | null, locationNode: string | null): HeadsetLocateTarget {
  return {
    ...placeFields(index, body?.modelNodeId ?? locationNode, body),
    kind: "equipment", id: equipment.id, name: equipment.name, assetId: equipment.id,
    placementId: body?.id ?? null, endpointId: null, routeIds: [], category: equipment.category,
    modelName: [equipment.manufacturer, equipment.modelName].filter(Boolean).join(" ") || null, servedFixtures: [],
  };
}

function installedRoutes(db: Db, modelId: string) {
  return db.select({ row: infraRoute }).from(infraRoute)
    .innerJoin(modelRevision, eq(infraRoute.modelRevisionId, modelRevision.id))
    .where(and(currentModel(modelId), eq(infraRoute.lifecycle, "installed"), eq(infraRoute.needsReconciliation, false)))
    .all().map(({ row }) => row);
}

/** Traverse only named, direction-documented water connections. Presence of a nearby fixture is no evidence. */
function servedFixtures(start: string, endpoints: Map<string, Endpoint>, routes: ReturnType<typeof installedRoutes>) {
  const visited = new Set([start]);
  const downstream = new Map<string, string[]>();
  for (const route of routes) {
    if ((route.medium !== "cold_water" && route.medium !== "hot_water") ||
      route.flowBasis !== "declared" || !route.fromEndpointId || !route.toEndpointId ||
      (route.flowDirection !== "forward" && route.flowDirection !== "reverse")) continue;
    const [from, to] = route.flowDirection === "forward" ? [route.fromEndpointId, route.toEndpointId] : [route.toEndpointId, route.fromEndpointId];
    const next = downstream.get(from) ?? [];
    next.push(to);
    downstream.set(from, next);
  }
  const names: HeadsetLocateTarget["servedFixtures"] = [];
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const id of downstream.get(queue[i]!) ?? []) {
      if (visited.has(id)) continue;
      visited.add(id);
      const endpoint = endpoints.get(id);
      if (!endpoint || endpoint.needsReconciliation) continue;
      if (endpoint.kind === "terminal") names.push({ id, name: endpoint.name });
      else queue.push(id);
    }
  }
  return names;
}

export function findHeadsetEquipment(db: Db, index: ManifestIndex, input: HeadsetFindInput): HeadsetSearchPage {
  const revisionId = db.select({ id: modelRevision.id }).from(modelRevision).where(currentModel(index.modelId)).get()?.id;
  const modelLocation = revisionId ? or(eq(location.modelRevisionId, revisionId), isNull(location.modelRevisionId)) : isNull(location.modelRevisionId);
  const equipment = db.select({ equipment: asset, locationNode: location.modelNodeId }).from(asset)
    .leftJoin(location, and(eq(asset.locationId, location.id), modelLocation))
    .where(installedAsset).orderBy(asc(asset.name)).limit(2000).all();
  const placementRows = db.select({ row: assetPlacement }).from(assetPlacement)
    .innerJoin(modelRevision, eq(assetPlacement.modelRevisionId, modelRevision.id))
    .where(and(currentModel(index.modelId), eq(assetPlacement.needsReconciliation, false),
      inArray(assetPlacement.placementKind, ["body", "shutoff"]))).all().map(({ row }) => row);
  const bodyByAsset = new Map(placementRows.filter((p) => p.placementKind === "body").map((p) => [p.assetId, p]));
  const shutoffByAsset = new Map(placementRows.filter((p) => p.placementKind === "shutoff").map((p) => [p.assetId, p]));
  const filterAssets = input.purpose === "ventilation_filter"
    ? new Set(db.select({ assetId: assetConsumable.assetId }).from(assetConsumable)
      .where(eq(assetConsumable.role, "filter")).all().map(({ assetId }) => assetId))
    : new Set<string>();
  const ventilationAssets = input.purpose === "ventilation_filter"
    ? new Set(db.select({ id: systemAsset.assetId }).from(systemAsset).innerJoin(system, eq(systemAsset.systemId, system.id))
      .where(and(eq(system.kind, "ventilation"), eq(system.status, "active"))).all().map(({ id }) => id))
    : new Set<string>();

  const candidates: HeadsetLocateTarget[] = [];
  const airHandlerFallbacks: HeadsetLocateTarget[] = [];
  const offset = input.offset ?? 0;
  const search = words(input.q ?? "").split(" ").filter(Boolean);
  if (input.purpose === "water_shutoff") {
    const routes = installedRoutes(db, index.modelId);
    const endpoints = db.select({ row: infraEndpoint, locationNode: location.modelNodeId, revisionModel: modelRevision.modelId })
      .from(infraEndpoint).leftJoin(modelRevision, eq(infraEndpoint.modelRevisionId, modelRevision.id))
      .leftJoin(location, and(eq(infraEndpoint.locationId, location.id), modelLocation))
      .where(and(eq(infraEndpoint.needsReconciliation, false), or(currentModel(index.modelId), isNull(infraEndpoint.modelRevisionId)))).all();
    const byId = new Map(endpoints.map(({ row }) => [row.id, row]));
    const linkedAssets = new Set<string>();
    for (const { row, locationNode, revisionModel } of endpoints) {
      if (row.kind !== "shutoff") continue;
      const incident = routes.filter((r) => r.fromEndpointId === row.id || r.toEndpointId === row.id);
      const isWater = incident.some((r) => REMOVABLE_MEDIA.some((medium) => medium === r.medium));
      const owner = equipment.find((item) => item.equipment.id === row.assetId)?.equipment;
      if (!isWater && !WATER_WORDS.test(words(row.name)) && owner?.category !== "plumbing") continue;
      const body = owner ? shutoffByAsset.get(owner.id) ?? bodyByAsset.get(owner.id) : undefined;
      const endpointPlace = placeFields(index, row.modelNodeId ?? locationNode, revisionModel ? row : null);
      const placementPlace = body ? placeFields(index, body.modelNodeId, body) : null;
      candidates.push({
        ...(endpointPlace.position ? endpointPlace : placementPlace ?? endpointPlace),
        id: row.id, kind: "endpoint", name: row.name, assetId: owner?.id ?? null,
        placementId: body?.id ?? null, endpointId: row.id, routeIds: incident.map(({ id }) => id), category: "plumbing",
        modelName: owner?.modelName ?? null, servedFixtures: servedFixtures(row.id, byId, routes),
      });
      if (owner) linkedAssets.add(owner.id);
    }
    for (const item of equipment) {
      const { equipment: owner, locationNode } = item;
      if (linkedAssets.has(owner.id)) continue;
      const record = words([owner.name, owner.modelName].filter(Boolean).join(" "));
      const explicitShutoff = shutoffByAsset.get(owner.id);
      if ((explicitShutoff || VALVE_WORDS.test(record)) && (owner.category === "plumbing" || WATER_WORDS.test(record)))
        candidates.push(makeEquipmentTarget(index, owner, explicitShutoff ?? bodyByAsset.get(owner.id) ?? null, locationNode));
    }
  } else {
    for (const { equipment: owner, locationNode } of equipment) {
      const body = bodyByAsset.get(owner.id) ?? null;
      const record = words([owner.name, owner.manufacturer, owner.modelName, body?.symbol].filter(Boolean).join(" "));
      if (input.purpose === "ventilation_filter") {
        const airHandler = body?.symbol === "ventilation_machine" || AIR_HANDLER_WORDS.test(record);
        if (!((airHandler || VENT_WORDS.test(record) || ventilationAssets.has(owner.id)) &&
          (filterAssets.has(owner.id) || FILTER_WORDS.test(record)))) {
          if (airHandler) airHandlerFallbacks.push({
            ...makeEquipmentTarget(index, owner, body, locationNode), finding: "air_handler_filter_unrecorded",
          });
          continue;
        }
      }
      if (input.purpose === "electrical_panel" && !PANEL_WORDS.test(record)) continue;
      candidates.push(makeEquipmentTarget(index, owner, body, locationNode));
    }
  }

  const inScope = (target: HeadsetLocateTarget) => (!input.onlyRoom || target.roomId === input.roomId) &&
    (!input.category || input.category === target.category) &&
    search.every((term) => words([target.name, target.modelName, target.category, target.roomName, target.floorName].join(" ")).includes(term));
  const exact = candidates.filter(inScope);
  const matches = exact.length ? exact : airHandlerFallbacks.filter(inScope);
  matches.sort((a, b) => Number(b.roomId !== null && b.roomId === input.roomId) - Number(a.roomId !== null && a.roomId === input.roomId) ||
    Number(!!b.position) - Number(!!a.position) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { items: matches.slice(offset, offset + PAGE_SIZE), nextOffset: offset + PAGE_SIZE < matches.length ? offset + PAGE_SIZE : null };
}

export function headsetEquipmentByPlacement(db: Db, index: ManifestIndex, placementId: string) {
  const row = db.select({ equipment: asset, body: assetPlacement, locationNode: location.modelNodeId }).from(assetPlacement)
    .innerJoin(asset, eq(assetPlacement.assetId, asset.id))
    .innerJoin(modelRevision, eq(assetPlacement.modelRevisionId, modelRevision.id))
    .leftJoin(location, eq(asset.locationId, location.id))
    .where(and(eq(assetPlacement.id, placementId), currentModel(index.modelId),
      eq(assetPlacement.needsReconciliation, false), installedAsset)).get();
  if (!row) throw notFound("unknown_headset_equipment");
  return makeEquipmentTarget(index, row.equipment, row.body, row.locationNode);
}

function taskRow(row: typeof maintenanceOccurrence.$inferSelect): HeadsetTaskRow {
  return { id: row.id, title: row.title, status: row.status === "due" ? "due" : "pending", dueDate: row.dueDate, priority: row.priority };
}

export function headsetMaintenanceOverview(db: Db, index: ManifestIndex, placementId: string): HeadsetMaintenanceOverview {
  const target = headsetEquipmentByPlacement(db, index, placementId);
  const assetId = target.assetId!;
  const tasks = db.select().from(maintenanceOccurrence).where(and(eq(maintenanceOccurrence.assetId, assetId), openOccurrence))
    .orderBy(asc(maintenanceOccurrence.dueDate), asc(maintenanceOccurrence.id)).limit(24).all().map(taskRow);
  const lastWork = db.select({ title: maintenanceOccurrence.title, date: completion.completedLocalDate, outcome: completion.outcome })
    .from(completion).innerJoin(maintenanceOccurrence, eq(maintenanceOccurrence.id, completion.occurrenceId))
    .where(and(eq(completion.assetId, assetId), isNull(completion.voidedAtMs)))
    .orderBy(desc(completion.completedAtMs)).get() ?? null;
  const parts = db.select({ row: part, role: assetConsumable.role }).from(assetConsumable).innerJoin(part, eq(assetConsumable.partId, part.id))
    .where(and(eq(assetConsumable.assetId, assetId), isNull(part.archivedAtMs))).limit(24).all().map(({ row, role }) => {
      const uses = db.select({ date: completion.completedLocalDate, outcome: completion.outcome, title: maintenanceOccurrence.title })
        .from(completionMaterial)
        .innerJoin(completion, eq(completionMaterial.completionId, completion.id))
        .innerJoin(maintenanceOccurrence, eq(completion.occurrenceId, maintenanceOccurrence.id))
        .where(and(eq(completion.assetId, assetId), isNull(completion.voidedAtMs),
          eq(completionMaterial.partId, row.id), gt(completionMaterial.actualQtyMilli, 0)))
        .orderBy(desc(completion.completedAtMs)).limit(24).all();
      const replacement = role === "filter" ? uses.find(({ outcome, title }) => {
        const text = words(title);
        return outcome !== "partial" && FILTER_WORDS.test(text) && FILTER_REPLACEMENT_WORDS.test(text);
      }) : undefined;
      return {
        partId: row.id, name: row.name, spec: row.spec, dimensions: row.dimensions, productCode: row.productCode,
        manufacturer: row.manufacturer, stockMilli: row.stockMode === "stocked" ? availableMilli(db, row.id) : null, unit: row.unit,
        lastUseDate: uses[0]?.date ?? null, lastReplacementDate: replacement?.date ?? null,
      };
    });
  return { target, tasks, lastWork, parts: [...new Map(parts.map((item) => [item.partId, item])).values()] };
}

function illustration(row: typeof attachment.$inferSelect, label: string, page?: number): HeadsetIllustration | null {
  if (row.mime === "application/pdf") return page && page >= 1 ? { kind: "pdf", attachmentId: row.id, page, label } : null;
  if (!/^image\/(jpeg|png|webp|avif)$/.test(row.mime) && !row.hasWebCopy) return null;
  return row.mime.startsWith("image/") ? { kind: "image", attachmentId: row.id, label,
    ...(row.hasWebCopy ? { preferredVariant: "web" as const } : {}) } : null;
}

export function headsetTask(db: Db, assetId: string, occurrenceId: string): HeadsetMaintenanceTask {
  const row = db.select().from(maintenanceOccurrence)
    .where(and(eq(maintenanceOccurrence.id, occurrenceId), eq(maintenanceOccurrence.assetId, assetId), openOccurrence)).get();
  if (!row) throw notFound("unknown_headset_task");
  const procedure = loadFrozenProcedure(db, row.procedureVersionId);
  const plan = row.planId ? db.select({ required: maintenancePlan.requiresProfessional, description: maintenancePlan.description }).from(maintenancePlan)
    .where(eq(maintenancePlan.id, row.planId)).get() : null;
  const providers = plan?.required ? db.select({ id: serviceProvider.id, name: serviceProvider.name }).from(serviceProvider)
    .where(isNull(serviceProvider.archivedAtMs)).orderBy(asc(serviceProvider.name)).limit(30).all() : [];

  const illustrations = new Map<string | null, HeadsetIllustration[]>();
  const put = (step: string | null, preview: HeadsetIllustration | null) => {
    if (!preview) return;
    const list = illustrations.get(step) ?? [];
    if (!list.some(({ attachmentId, page }) => attachmentId === preview.attachmentId && page === preview.page) && list.length < 8) list.push(preview);
    illustrations.set(step, list);
  };
  if (procedure) {
    const stepIds = procedure.steps.map(({ id }) => id);
    const refs = [
      and(eq(attachmentLink.entityKind, "procedure_version"), eq(attachmentLink.entityId, procedure.versionId)),
      and(eq(attachmentLink.entityKind, "asset"), eq(attachmentLink.entityId, assetId)),
      ...(stepIds.length ? [and(eq(attachmentLink.entityKind, "procedure_step"), inArray(attachmentLink.entityId, stepIds))] : []),
    ];
    const files = db.select({ row: attachment, link: attachmentLink }).from(attachmentLink)
      .innerJoin(attachment, eq(attachmentLink.attachmentId, attachment.id)).where(or(...refs))
      .orderBy(asc(attachmentLink.seq)).limit(100).all();
    for (const file of files) {
      if (file.link.entityKind === "asset") continue;
      put(file.link.entityKind === "procedure_step" ? file.link.entityId : null,
        illustration(file.row, file.row.caption ?? file.row.originalFilename));
    }
    const attachmentIds = procedure.references.flatMap((ref) => ref.attachmentId ? [ref.attachmentId] : []);
    const byId = new Map((attachmentIds.length ? db.select().from(attachment).where(inArray(attachment.id, attachmentIds)).all() : [])
      .map((file) => [file.id, file]));
    for (const reference of procedure.references) {
      const key = reference.manualName === null ? null : words(reference.manualName.replace(/\.pdf$/i, ""));
      const named = key ? files.filter(({ row, link }) => link.entityKind === "asset" && row.mime === "application/pdf" &&
        [row.originalFilename, row.caption].some((title) => title && words(title.replace(/\.pdf$/i, "")) === key)) : [];
      const file = reference.attachmentId ? byId.get(reference.attachmentId) : named.length === 1 ? named[0]?.row : undefined;
      if (!file) continue;
      const first = reference.pageFrom ?? undefined;
      if (file.mime === "application/pdf" && first) {
        const final = Math.min(reference.pageTo ?? first, first + 5);
        for (let page = first; page <= final; page++) put(null, illustration(file, reference.label, page));
      } else put(null, illustration(file, reference.label));
    }
  }
  return {
    ...taskRow(row), description: plan?.description ?? null, procedure,
    progress: loadProgress(db, occurrenceId), materials: loadMaterialLines(db, occurrenceId), providers,
    requiresProfessional: plan?.required ?? false,
    photos: loadTaskPhotos(db, occurrenceId, null).filter((photo) => photo.mime.startsWith("image/"))
      .slice(0, 30).map((photo) => ({ id: photo.attachmentId, label: photo.caption ?? photo.originalFilename })),
    illustrations: [...illustrations.entries()].map(([stepId, previews]) => ({ stepId, previews })),
  };
}
