/**
 * Fixtures for the completion / inventory / condition / reorder tests.
 *
 * One builder object per test, so each test reads as "given this shelf and this task, when …".
 * Everything goes through the real migrations (`testDb`) and the real service functions where a
 * service exists; only rows with no service yet (parts, assets, plans, HA registry entries) are
 * inserted directly.
 *
 * The clock starts in the **past** relative to any plausible wall clock, because `part_stock`'s
 * `effective_milli` compares `occurred_at_ms` against `unixepoch()`; with a past fixture date
 * `effective_milli` and `on_hand_milli` agree and the view is testable without freezing `Date`.
 */
import { eq } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  asset,
  assetConsumable,
  assetHaLink,
  conditionRule,
  haDevice,
  haEntity,
  kitComponent,
  location,
  maintenanceOccurrence,
  maintenancePlan,
  notificationRecipientState,
  part,
  partLot,
  planMaterial,
  procedure,
  procedureMaterial,
  procedureVersion,
  storagePlace,
  userNotifyDevice,
  type AssetCategory,
  type AssignmentMode,
  type ConsumableRole,
  type HaLinkRole,
  type PartTrackingMode,
  type PartUnit,
  type Priority,
} from "@/db/schema";
import type { DomainContext } from "@/domain/inventory";
import { fakeClock, type FakeClock } from "../../helpers/clock";
import { seedUser, testDb, type SeededUser } from "../../helpers/db";

export const TZ = "Europe/Helsinki";
/** 2026-06-10 09:00 Europe/Helsinki. Comfortably in the past, comfortably not a DST boundary. */
export const START_LOCAL = "2026-06-10T09:00";
export const START_DATE = "2026-06-10";

export interface PartSpec {
  name: string;
  trackingMode?: PartTrackingMode;
  unit?: PartUnit;
  isKit?: boolean;
  stockMode?: "stocked" | "not_stocked";
  tracksLots?: boolean;
  reorderThresholdMilli?: number | null;
  reorderTargetMilli?: number | null;
  leadTimeDays?: number | null;
}

export interface AssetSpec {
  name: string;
  category?: AssetCategory;
  locationId?: string | null;
  status?: "planned" | "installed" | "removed" | "retired" | "lost";
  installedOn?: string | null;
}

export interface PlanSpec {
  title: string;
  assetId?: string | null;
  locationId?: string | null;
  recurrenceJson?: string;
  scheduleKind?: "interval_from_completion" | "fixed_calendar" | "seasonal_window" | "one_off";
  scheduleAnchorDate?: string | null;
  scheduleAnchorSource?: "completion" | "baseline_exact" | "user_chosen" | "none";
  assignmentMode?: AssignmentMode;
  assigneeUserId?: string | null;
  procedureId?: string | null;
  status?: "active" | "paused" | "cancelled";
}

export interface OccurrenceSpec {
  title?: string;
  planId?: string | null;
  assetId?: string | null;
  locationId?: string | null;
  source?: "plan" | "manual" | "condition";
  status?: "pending" | "due";
  dueDate?: string;
  procedureVersionId?: string | null;
  assignmentMode?: AssignmentMode;
  assigneeUserId?: string | null;
  priority?: Priority;
  conditionRuleId?: string | null;
}

export interface EntitySpec {
  entityId: string;
  deviceId?: string | null;
  deviceClass?: string | null;
  unit?: string | null;
  disabledBy?: string | null;
  hiddenBy?: string | null;
}

export interface Fixture {
  handle: DbHandle;
  db: Db;
  clock: FakeClock;
  tz: string;
  ctx: DomainContext;
  workerCtx: DomainContext;
  lucas: SeededUser;
  marja: SeededUser;
  locationId: string;
  storagePlaceId: string;
  close(): void;
  /** Run `fn` inside a real write transaction. */
  tx<T>(fn: (tx: Db) => T): T;
  addPart(spec: PartSpec): string;
  addKit(kitPartId: string, componentPartId: string, qtyMilli: number): void;
  addLot(
    partId: string,
    spec?: { label?: string; initialQtyMilli?: number; isOpen?: boolean; expiresOn?: string | null },
  ): string;
  addAsset(spec: AssetSpec): string;
  addConsumable(assetId: string, partId: string, role: ConsumableRole, qtyMilli: number): string;
  addProcedure(spec?: { title?: string; materials?: Array<{ partId: string; qtyMilli: number }> }): {
    procedureId: string;
    versionId: string;
  };
  addPlan(spec: PlanSpec): string;
  addPlanMaterial(planId: string, partId: string, qtyMilli: number, isRequired?: boolean): string;
  addOccurrence(spec: OccurrenceSpec): string;
  /** Seed the notify rows the engine would have created, so clears/snoozes have something to hit. */
  addRecipientStates(occurrenceId: string, dueDate?: string): void;
  /** One `notify.mobile_app_*` service per user, so clears have a device to be enqueued for. */
  addNotifyDevices(): string[];
  addDevice(spec?: { deviceId?: string; name?: string }): string;
  addEntity(spec: EntitySpec): string;
  linkAsset(
    assetId: string,
    spec: { entityRegistryId?: string; deviceId?: string; role?: HaLinkRole },
  ): string;
  addConditionRule(spec?: {
    scope?: "all_batteries" | "asset" | "entity";
    assetId?: string | null;
    entityRegistryId?: string | null;
    thresholdPct?: number | null;
    clearThresholdPct?: number | null;
    sustainMinutes?: number | null;
    clearSustainMinutes?: number | null;
    defaultPartId?: string | null;
    procedureId?: string | null;
    assignmentMode?: AssignmentMode;
    assigneeUserId?: string | null;
    enabled?: boolean;
    titleTemplate?: string;
  }): string;
}

const SIX_MONTHS_FROM_COMPLETION = JSON.stringify({
  v: 1,
  kind: "interval_from_completion",
  every: 6,
  unit: "month",
});

/** A fresh database, a fake clock, two named users, one location and one storage place. */
export function makeFixture(): Fixture {
  const handle = testDb();
  const clock = fakeClock(0);
  clock.advanceToLocal(START_LOCAL, TZ);

  const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });
  const marja = seedUser(handle, { username: "marja", name: "Marja" });

  const ctx: DomainContext = { clock, tz: TZ, actorUserId: lucas.id, actorKind: "user" };
  const workerCtx: DomainContext = { clock, tz: TZ, actorUserId: null, actorKind: "worker" };

  const tx = <T>(fn: (t: Db) => T): T => writeTx(handle.db, fn);
  const audit = () => ({
    createdAtMs: clock.now(),
    createdBy: lucas.id,
    updatedAtMs: clock.now(),
    updatedBy: lucas.id,
  });

  const locationId = newId();
  const storagePlaceId = newId();
  tx((t) => {
    t.insert(location)
      .values({
        id: locationId,
        kind: "property",
        name: "Test property",
        slug: "test-property",
        createdAtMs: clock.now(),
        updatedAtMs: clock.now(),
      })
      .run();
    t.insert(storagePlace)
      .values({ id: storagePlaceId, name: "Garage shelf B", locationId, ...audit() })
      .run();
  });

  return {
    handle,
    db: handle.db,
    clock,
    tz: TZ,
    ctx,
    workerCtx,
    lucas,
    marja,
    locationId,
    storagePlaceId,
    close: () => handle.close(),
    tx,

    addPart(spec) {
      const id = newId();
      tx((t) =>
        t
          .insert(part)
          .values({
            id,
            name: spec.name,
            trackingMode: spec.trackingMode ?? "discrete",
            unit: spec.unit ?? "pcs",
            isKit: spec.isKit ?? false,
            stockMode: spec.stockMode ?? "stocked",
            tracksLots: spec.tracksLots ?? false,
            reorderThresholdMilli: spec.reorderThresholdMilli ?? null,
            reorderTargetMilli: spec.reorderTargetMilli ?? null,
            leadTimeDays: spec.leadTimeDays ?? null,
            ...audit(),
          })
          .run(),
      );
      return id;
    },

    addKit(kitPartId, componentPartId, qtyMilli) {
      tx((t) => t.insert(kitComponent).values({ kitPartId, componentPartId, qtyMilli }).run());
    },

    addLot(partId, spec = {}) {
      const id = newId();
      tx((t) =>
        t
          .insert(partLot)
          .values({
            id,
            partId,
            label: spec.label ?? `lot-${id}`,
            storagePlaceId,
            initialQtyMilli: spec.initialQtyMilli ?? null,
            isOpen: spec.isOpen ?? true,
            expiresOn: spec.expiresOn ?? null,
            ...audit(),
          })
          .run(),
      );
      return id;
    },

    addAsset(spec) {
      const id = newId();
      tx((t) =>
        t
          .insert(asset)
          .values({
            id,
            name: spec.name,
            category: spec.category ?? "safety",
            locationId: spec.locationId === undefined ? locationId : spec.locationId,
            status: spec.status ?? "installed",
            installedOn: spec.installedOn ?? START_DATE,
            installedOnPrecision: "exact",
            ...audit(),
          })
          .run(),
      );
      return id;
    },

    addConsumable(assetId, partId, role, qtyMilli) {
      const id = newId();
      tx((t) =>
        t.insert(assetConsumable).values({ id, assetId, partId, role, qtyMilli }).run(),
      );
      return id;
    },

    addProcedure(spec = {}) {
      const procedureId = newId();
      const versionId = newId();
      tx((t) => {
        t.insert(procedure)
          .values({
            id: procedureId,
            title: spec.title ?? "Replace the battery",
            slug: `proc-${procedureId}`,
            ...audit(),
          })
          .run();
        t.insert(procedureVersion)
          .values({
            id: versionId,
            procedureId,
            version: 1,
            status: "published",
            publishedAtMs: clock.now(),
            ...audit(),
          })
          .run();
        t.update(procedure)
          .set({ currentVersionId: versionId })
          .where(eq(procedure.id, procedureId))
          .run();
        for (const material of spec.materials ?? []) {
          t.insert(procedureMaterial)
            .values({
              id: newId(),
              versionId,
              partId: material.partId,
              qtyMilli: material.qtyMilli,
              isRequired: true,
            })
            .run();
        }
      });
      return { procedureId, versionId };
    },

    addPlan(spec) {
      const id = newId();
      const assetId = spec.assetId ?? null;
      tx((t) =>
        t
          .insert(maintenancePlan)
          .values({
            id,
            title: spec.title,
            assetId,
            locationId: assetId === null ? (spec.locationId ?? locationId) : null,
            procedureId: spec.procedureId ?? null,
            scheduleKind: spec.scheduleKind ?? "interval_from_completion",
            recurrenceJson: spec.recurrenceJson ?? SIX_MONTHS_FROM_COMPLETION,
            scheduleAnchorDate: spec.scheduleAnchorDate ?? START_DATE,
            scheduleAnchorSource: spec.scheduleAnchorSource ?? "user_chosen",
            assignmentMode: spec.assignmentMode ?? "shared",
            assigneeUserId: spec.assigneeUserId ?? null,
            status: spec.status ?? "active",
            ...audit(),
          })
          .run(),
      );
      return id;
    },

    addPlanMaterial(planId, partId, qtyMilli, isRequired = true) {
      const id = newId();
      tx((t) =>
        t.insert(planMaterial).values({ id, planId, partId, qtyMilli, isRequired }).run(),
      );
      return id;
    },

    addOccurrence(spec) {
      const id = newId();
      const dueDate = spec.dueDate ?? START_DATE;
      const planId = spec.planId ?? null;
      const source = spec.source ?? (planId === null ? "manual" : "plan");
      const assetId = spec.assetId ?? null;
      tx((t) =>
        t
          .insert(maintenanceOccurrence)
          .values({
            id,
            planId,
            source,
            conditionRuleId: spec.conditionRuleId ?? null,
            assetId,
            locationId: assetId === null ? (spec.locationId ?? locationId) : null,
            title: spec.title ?? "Test task",
            procedureVersionId: spec.procedureVersionId ?? null,
            status: spec.status ?? "due",
            dueDate,
            originalDueDate: dueDate,
            assignmentMode: spec.assignmentMode ?? "shared",
            assigneeUserId: spec.assigneeUserId ?? null,
            priority: spec.priority ?? "normal",
            becameDueAtMs: (spec.status ?? "due") === "due" ? clock.now() : null,
            ...audit(),
          })
          .run(),
      );
      return id;
    },

    addRecipientStates(occurrenceId, dueDate = START_DATE) {
      tx((t) => {
        for (const recipient of [lucas, marja]) {
          t.insert(notificationRecipientState)
            .values({
              id: newId(),
              occurrenceId,
              recipientUserId: recipient.id,
              tag: `vh:occ:${occurrenceId}:${recipient.id}`,
              anchorDate: dueDate,
              state: "active",
              nextSlotIndex: 0,
              createdAtMs: clock.now(),
              updatedAtMs: clock.now(),
            })
            .run();
        }
      });
    },

    addNotifyDevices() {
      const ids: string[] = [];
      tx((t) => {
        for (const recipient of [lucas, marja]) {
          const id = newId();
          t.insert(userNotifyDevice)
            .values({
              id,
              userId: recipient.id,
              label: `${recipient.name} iPhone`,
              notifyService: `notify.mobile_app_${recipient.username}_iphone`,
              haDeviceName: `${recipient.name} iPhone`,
              isActive: true,
              createdAtMs: clock.now(),
              createdBy: recipient.id,
            })
            .run();
          ids.push(id);
        }
      });
      return ids;
    },

    addDevice(spec = {}) {
      const deviceId = spec.deviceId ?? newId();
      tx((t) =>
        t
          .insert(haDevice)
          .values({
            deviceId,
            name: spec.name ?? "Smoke alarm",
            firstSeenMs: clock.now(),
            lastSeenMs: clock.now(),
          })
          .run(),
      );
      return deviceId;
    },

    addEntity(spec) {
      const registryId = newId();
      tx((t) =>
        t
          .insert(haEntity)
          .values({
            registryId,
            entityId: spec.entityId,
            uniqueId: `uid-${registryId}`,
            platform: "test",
            deviceId: spec.deviceId ?? null,
            domain: spec.entityId.split(".")[0] ?? "sensor",
            deviceClass: spec.deviceClass ?? "battery",
            unitOfMeasurement: spec.unit === undefined ? "%" : spec.unit,
            disabledBy: spec.disabledBy ?? null,
            hiddenBy: spec.hiddenBy ?? null,
            firstSeenMs: clock.now(),
            lastSeenMs: clock.now(),
          })
          .run(),
      );
      return registryId;
    },

    linkAsset(assetId, spec) {
      const id = newId();
      const linkKind = spec.entityRegistryId ? "entity" : "device";
      tx((t) =>
        t
          .insert(assetHaLink)
          .values({
            id,
            assetId,
            linkKind,
            haDeviceId: linkKind === "device" ? (spec.deviceId ?? null) : null,
            haEntityRegistryId: linkKind === "entity" ? (spec.entityRegistryId ?? null) : null,
            role: spec.role ?? "primary",
            linkState: "active",
            linkStateChangedAtMs: clock.now(),
            ...audit(),
          })
          .run(),
      );
      return id;
    },

    addConditionRule(spec = {}) {
      const id = newId();
      const scope = spec.scope ?? "all_batteries";
      tx((t) =>
        t
          .insert(conditionRule)
          .values({
            id,
            kind: "low_battery",
            name: "Low battery",
            scope,
            assetId: spec.assetId ?? null,
            haEntityRegistryId: spec.entityRegistryId ?? null,
            thresholdPct: spec.thresholdPct ?? null,
            clearThresholdPct: spec.clearThresholdPct ?? null,
            sustainMinutes: spec.sustainMinutes ?? null,
            clearSustainMinutes: spec.clearSustainMinutes ?? null,
            procedureId: spec.procedureId ?? null,
            defaultPartId: spec.defaultPartId ?? null,
            priority: "normal",
            assignmentMode: spec.assignmentMode ?? "shared",
            assigneeUserId: spec.assigneeUserId ?? null,
            titleTemplate: spec.titleTemplate ?? "Replace battery: {{asset}}",
            enabled: spec.enabled ?? true,
            ...audit(),
          })
          .run(),
      );
      return id;
    },
  };
}
