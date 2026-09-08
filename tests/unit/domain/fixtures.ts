/**
 * Fixtures for the domain tests: a fresh in-memory database built by the **real migrations**, two
 * seeded users, a fake clock, and small builders that insert rows directly with Drizzle.
 *
 * Deliberately direct inserts rather than domain calls: a test about `markCompleted` must be able
 * to set up an occurrence that `createOccurrenceForPlan` would never produce (already overdue,
 * mid-series, blocked) without the setup path being part of what is under test.
 */
import { eq } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { asset, assetConsumable } from "@/db/schema/assets";
import { HOUSEHOLD_SETTING_ID, householdSetting, userNotifyDevice } from "@/db/schema/household";
import { part, stockTransaction } from "@/db/schema/inventory";
import {
  completion,
  maintenanceOccurrence,
  maintenancePlan,
  planMaterial,
  type AssignmentMode,
  type OccurrenceStatus,
  type Priority,
  type ScheduleAnchorSource,
  type ScheduleKind,
} from "@/db/schema/maintenance";
import {
  procedure,
  procedureChecklistItem,
  procedureMaterial,
  procedureVersion,
  type ChecklistValueKind,
} from "@/db/schema/procedures";
import type { DomainCtx, HouseholdSettings } from "@/domain/occurrence";
import { loadHousehold } from "@/domain/occurrence";
import type { RecurrenceRule } from "@/domain/recurrence";
import type { LocalDate } from "@/domain/time";
import { seedUser, testDb, type SeededUser } from "../../helpers/db";
import { fakeClock, type FakeClock } from "../../helpers/clock";

export const TZ = "Europe/Helsinki";

export interface TestWorld {
  handle: DbHandle;
  clock: FakeClock;
  tz: string;
  lucas: SeededUser;
  marja: SeededUser;
  /** Actor: Lucas, acting through the web. */
  ctx: DomainCtx;
  /** Actor: the worker (no user behind it). */
  workerCtx: DomainCtx;
  settings(): HouseholdSettings;
  close(): void;
}

/** A world at `startIso`, with migrations applied and both household members seeded. */
export function makeWorld(startIso: string, tz: string = TZ): TestWorld {
  const handle = testDb();
  const clock = fakeClock(startIso);
  const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });
  const marja = seedUser(handle, { username: "marja", name: "Marja" });
  if (tz !== TZ) setHousehold(handle, { timezone: tz });
  return {
    handle,
    clock,
    tz,
    lucas,
    marja,
    ctx: { clock, tz, actorUserId: lucas.id, actorKind: "user" },
    workerCtx: { clock, tz, actorUserId: null, actorKind: "worker" },
    settings: () => writeTx(handle.db, (tx) => loadHousehold(tx)),
    close: () => {
      handle.close();
    },
  };
}

/** Patch the singleton `household_setting` row. */
export function setHousehold(
  handle: DbHandle,
  patch: Partial<typeof householdSetting.$inferInsert>,
): void {
  writeTx(handle.db, (tx) => {
    tx.update(householdSetting)
      .set({ ...patch, updatedAtMs: Date.now() })
      .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
      .run();
  });
}

export interface MakeAssetInput {
  name?: string;
  installedOn?: LocalDate | null;
  category?: (typeof asset.$inferInsert)["category"];
}

export function makeAsset(world: TestWorld, input: MakeAssetInput = {}): string {
  const id = newId();
  const at = world.clock.now();
  writeTx(world.handle.db, (tx) => {
    tx.insert(asset)
      .values({
        id,
        name: input.name ?? "Ventilation unit",
        category: input.category ?? "hvac",
        status: "installed",
        installedOn: input.installedOn ?? null,
        installedOnPrecision: input.installedOn ? "exact" : null,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
  });
  return id;
}

export interface MakePartInput {
  name?: string;
  isKit?: boolean;
  stockMode?: "stocked" | "not_stocked";
  tracksLots?: boolean;
  unit?: (typeof part.$inferInsert)["unit"];
  trackingMode?: (typeof part.$inferInsert)["trackingMode"];
}

export function makePart(world: TestWorld, input: MakePartInput = {}): string {
  const id = newId();
  const at = world.clock.now();
  writeTx(world.handle.db, (tx) => {
    tx.insert(part)
      .values({
        id,
        name: input.name ?? "HEPA filter F7",
        trackingMode: input.trackingMode ?? "discrete",
        unit: input.unit ?? "pcs",
        isKit: input.isKit ?? false,
        stockMode: input.stockMode ?? "stocked",
        tracksLots: input.tracksLots ?? false,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
  });
  return id;
}

/** Add stock with an `initial_count` transaction (the honest way to seed a balance). */
export function addStock(world: TestWorld, partId: string, qtyMilli: number): void {
  const at = world.clock.now();
  writeTx(world.handle.db, (tx) => {
    tx.insert(stockTransaction)
      .values({
        id: newId(),
        partId,
        qtyMilli,
        kind: "initial_count",
        reason: "initial_seed",
        occurredAtMs: at,
        occurredLocalDate: "2026-01-01",
        createdAtMs: at,
      })
      .run();
  });
}

export function addConsumable(
  world: TestWorld,
  assetId: string,
  partId: string,
  qtyMilli: number,
  role: (typeof assetConsumable.$inferInsert)["role"] = "filter",
): void {
  writeTx(world.handle.db, (tx) => {
    tx.insert(assetConsumable).values({ id: newId(), assetId, partId, role, qtyMilli }).run();
  });
}

export interface MakeDeviceInput {
  label?: string;
  notifyService?: string;
  haDeviceName?: string | null;
  isActive?: boolean;
}

let deviceCounter = 0;

export function makeDevice(world: TestWorld, userId: string, input: MakeDeviceInput = {}): string {
  const id = newId();
  const at = world.clock.now();
  const label = input.label ?? `phone-${++deviceCounter}`;
  writeTx(world.handle.db, (tx) => {
    tx.insert(userNotifyDevice)
      .values({
        id,
        userId,
        label,
        notifyService:
          input.notifyService ?? `notify.mobile_app_${label.replace(/[^a-z0-9]+/gi, "_")}`,
        haDeviceName: input.haDeviceName ?? label,
        isActive: input.isActive ?? true,
        createdAtMs: at,
      })
      .run();
  });
  return id;
}

export interface MakeProcedureInput {
  title?: string;
  requiresValue?: ChecklistValueKind | null;
  materials?: Array<{ partId: string; qtyMilli: number; isRequired?: boolean }>;
}

export function makeProcedure(
  world: TestWorld,
  input: MakeProcedureInput = {},
): { procedureId: string; versionId: string } {
  const procedureId = newId();
  const versionId = newId();
  const at = world.clock.now();
  writeTx(world.handle.db, (tx) => {
    tx.insert(procedure)
      .values({
        id: procedureId,
        title: input.title ?? "Replace filter",
        slug: `proc-${procedureId.slice(0, 8)}`,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
    tx.insert(procedureVersion)
      .values({
        id: versionId,
        procedureId,
        version: 1,
        status: "published",
        publishedAtMs: at,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
    tx.update(procedure)
      .set({ currentVersionId: versionId })
      .where(eq(procedure.id, procedureId))
      .run();
    tx.insert(procedureChecklistItem)
      .values({
        id: newId(),
        versionId,
        stepId: null,
        seq: 0,
        text: "Filter seated correctly",
        requiresValue: input.requiresValue ?? null,
      })
      .run();
    for (const material of input.materials ?? []) {
      tx.insert(procedureMaterial)
        .values({
          id: newId(),
          versionId,
          partId: material.partId,
          qtyMilli: material.qtyMilli,
          isRequired: material.isRequired ?? true,
        })
        .run();
    }
  });
  return { procedureId, versionId };
}

export interface MakePlanInput {
  title?: string;
  rule: RecurrenceRule;
  scheduleKind?: ScheduleKind;
  anchorDate?: LocalDate | null;
  anchorSource?: ScheduleAnchorSource;
  assignmentMode?: AssignmentMode;
  assigneeUserId?: string | null;
  assetId?: string;
  status?: "active" | "paused" | "cancelled";
  requiresProfessional?: boolean;
  procedureId?: string | null;
  priority?: Priority;
  materials?: Array<{ partId: string; qtyMilli: number; isRequired?: boolean }>;
}

const SCHEDULE_KIND_FOR: Record<RecurrenceRule["kind"], ScheduleKind> = {
  one_off: "one_off",
  condition: "condition",
  interval_from_completion: "interval_from_completion",
  fixed_monthly: "fixed_calendar",
  fixed_yearly: "fixed_calendar",
  fixed_interval: "fixed_calendar",
  seasonal_window: "seasonal_window",
};

export function makePlan(world: TestWorld, input: MakePlanInput): string {
  const id = newId();
  const at = world.clock.now();
  const assetId = input.assetId ?? makeAsset(world);
  writeTx(world.handle.db, (tx) => {
    tx.insert(maintenancePlan)
      .values({
        id,
        title: input.title ?? "Replace ventilation filters",
        assetId,
        procedureId: input.procedureId ?? null,
        scheduleKind: input.scheduleKind ?? SCHEDULE_KIND_FOR[input.rule.kind],
        recurrenceJson: JSON.stringify(input.rule),
        scheduleAnchorDate: input.anchorDate ?? null,
        scheduleAnchorSource: input.anchorSource ?? (input.anchorDate ? "baseline_exact" : "none"),
        assignmentMode: input.assignmentMode ?? "shared",
        assigneeUserId: input.assignmentMode === "user" ? (input.assigneeUserId ?? null) : null,
        priority: input.priority ?? "normal",
        requiresProfessional: input.requiresProfessional ?? false,
        status: input.status ?? "active",
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
    for (const material of input.materials ?? []) {
      tx.insert(planMaterial)
        .values({
          id: newId(),
          planId: id,
          partId: material.partId,
          qtyMilli: material.qtyMilli,
          isRequired: material.isRequired ?? true,
        })
        .run();
    }
  });
  return id;
}

export interface MakeOccurrenceInput {
  planId?: string | null;
  title?: string;
  dueDate: LocalDate;
  originalDueDate?: LocalDate;
  status?: OccurrenceStatus;
  assignmentMode?: AssignmentMode;
  assigneeUserId?: string | null;
  assetId?: string | null;
  procedureVersionId?: string | null;
  priority?: Priority;
  becameDueAtMs?: number | null;
  /**
   * Overrides `generation_note_json`. By default a plan-sourced occurrence carries the plan's
   * anchor, exactly as `createOccurrenceForPlan` stamps it: a reopen or a void reads that note to
   * revert the plan anchor, so a fixture without it would revert the plan to `'none'`.
   */
  generationNote?: Record<string, unknown> | null;
}

/** Insert an occurrence directly, in whatever state the test needs. */
export function makeOccurrence(world: TestWorld, input: MakeOccurrenceInput): string {
  const id = newId();
  const at = world.clock.now();
  const status = input.status ?? "pending";
  const plan = input.planId
    ? world.handle.db
        .select()
        .from(maintenancePlan)
        .where(eq(maintenancePlan.id, input.planId))
        .all()[0]
    : undefined;
  const note =
    input.generationNote !== undefined
      ? input.generationNote
      : plan
        ? { anchorDate: plan.scheduleAnchorDate, anchorSource: plan.scheduleAnchorSource }
        : null;
  writeTx(world.handle.db, (tx) => {
    tx.insert(maintenanceOccurrence)
      .values({
        id,
        planId: input.planId ?? null,
        source: input.planId ? "plan" : "manual",
        generationNoteJson: note === null ? null : JSON.stringify(note),
        assetId: input.assetId ?? null,
        title: input.title ?? "Replace ventilation filters",
        procedureVersionId: input.procedureVersionId ?? null,
        status,
        dueDate: input.dueDate,
        originalDueDate: input.originalDueDate ?? input.dueDate,
        assignmentMode: input.assignmentMode ?? "shared",
        assigneeUserId: input.assigneeUserId ?? null,
        priority: input.priority ?? "normal",
        becameDueAtMs: input.becameDueAtMs ?? (status === "due" ? at : null),
        closedAtMs:
          status === "completed" || status === "skipped" || status === "cancelled" ? at : null,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
  });
  return id;
}

export interface MakeCompletionInput {
  occurrenceId: string;
  planId?: string | null;
  assetId?: string | null;
  completedLocalDate: LocalDate;
  completedAtMs?: number;
  requestId?: string;
  performedByUserId?: string;
}

/** Insert a `completion` row the way the completion module would, minus the stock ledger. */
export function makeCompletion(world: TestWorld, input: MakeCompletionInput): string {
  const id = newId();
  const at = input.completedAtMs ?? world.clock.now();
  writeTx(world.handle.db, (tx) => {
    tx.insert(completion)
      .values({
        id,
        requestId: input.requestId ?? `req-${id}`,
        occurrenceId: input.occurrenceId,
        planId: input.planId ?? null,
        assetId: input.assetId ?? null,
        completedAtMs: at,
        completedLocalDate: input.completedLocalDate,
        performedByUserId: input.performedByUserId ?? world.lucas.id,
        recordedBy: world.lucas.id,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
  });
  return id;
}
