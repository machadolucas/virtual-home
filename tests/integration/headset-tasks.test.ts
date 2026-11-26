import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTx, type DbHandle } from "@/db/client";
import {
  asset, assetConsumable, assetPlacement, attachment, attachmentLink, completion, infraEndpoint, infraRoute,
  maintenanceOccurrence, modelRevision, part, procedure, procedureChecklistItem, procedureMaterial, procedureReference,
  procedureStep, procedureVersion, stockTransaction,
} from "@/db/schema";
import { availableMilli } from "@/domain/inventory";
import type { DomainCtx } from "@/domain/occurrence";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { ManifestSchema } from "@/house/model/schema";
import { headsetTaskWrite } from "@/house/xr/headsetTasksTypes";
import { writeHeadsetTask } from "@/server/operations/maintenance/headset";
import { findHeadsetEquipment, headsetEquipmentByPlacement, headsetMaintenanceOverview, headsetTask } from "@/server/queries/maintenance/headset";
import manifest from "../fixtures/model/house-model/model.json";
import { seedUser, testDb } from "../helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const index = buildManifestIndex(ManifestSchema.parse(manifest));
const at = Date.UTC(2026, 10, 25, 13);
const audit = { createdAtMs: at, updatedAtMs: at };
const roomId = "r-l-a";
let db: DbHandle;
let ctx: DomainCtx;
const equipmentId = "synthetic-vent-unit";
const placementId = "synthetic-vent-placement";
const taskId = "synthetic-filter-task";
const filterId = "synthetic-filter";

beforeEach(() => {
  db = testDb();
  const actor = seedUser(db, { username: "xr-fixture", name: "Synthetic House Member" });
  ctx = { actorUserId: actor.id, actorKind: "user", clock: { now: () => at }, tz: "Europe/Helsinki" };
  writeTx(db.db, (tx) => {
    tx.insert(modelRevision).values({
      id: "fixture-revision", modelId: index.modelId, schemaVersion: "1.0", contentHash: "12345678",
      generatedAtMs: at, importedAtMs: at, nodeCount: 0, coordinateSystemJson: "{}", status: "current",
    }).run();
    tx.insert(asset).values([
      { id: equipmentId, name: "Ilmanvaihtokone", category: "hvac", modelName: "Fixture 50", status: "installed", ...audit },
      { id: "synthetic-unused", name: "Spare ventilation filter", category: "hvac", status: "retired", ...audit },
      { id: "synthetic-kitchen", name: "Fixture kettle", category: "appliance", status: "installed", ...audit },
    ]).run();
    tx.insert(assetPlacement).values({
      id: placementId, assetId: equipmentId, modelRevisionId: "fixture-revision", modelNodeId: roomId,
      posX: 2, posY: 1, posZ: 1, ...audit,
    }).run();
    tx.insert(part).values({
      id: filterId, name: "Fixture intake filter", spec: "Synthetic 250 mm", dimensions: "250 × 80 mm",
      productCode: "TEST-250", unit: "pcs", trackingMode: "discrete", ...audit,
    }).run();
    tx.insert(assetConsumable).values({ id: "consumable-fixture", assetId: equipmentId, partId: filterId, role: "filter", qtyMilli: 1000 }).run();
    tx.insert(procedure).values({ id: "proc-fixture", title: "Service the ventilation unit", slug: "fixture-procedure", ...audit }).run();
    tx.insert(procedureVersion).values([
      { id: "frozen-fixture", procedureId: "proc-fixture", version: 1, status: "superseded", ...audit },
      { id: "new-fixture", procedureId: "proc-fixture", version: 2, status: "published", ...audit },
    ]).run();
    tx.update(procedure).set({ currentVersionId: "new-fixture" }).where(eq(procedure.id, "proc-fixture")).run();
    tx.insert(procedureStep).values([
      { id: "step-fixture", versionId: "frozen-fixture", seq: 0, title: "Change the intake filter" },
      { id: "other-step", versionId: "new-fixture", seq: 0, title: "New unrelated instructions" },
    ]).run();
    tx.insert(procedureChecklistItem).values({
      id: "measure-fixture", versionId: "frozen-fixture", stepId: "step-fixture", seq: 1,
      text: "Record the pressure reading", requiresValue: "number", unit: "Pa",
    }).run();
    tx.insert(procedureMaterial).values({ id: "material-fixture", versionId: "frozen-fixture", partId: filterId, qtyMilli: 1000 }).run();
    tx.insert(maintenanceOccurrence).values([
      { id: taskId, title: "Change intake filter", source: "manual", assetId: equipmentId, procedureVersionId: "frozen-fixture",
        dueDate: "2026-11-25", originalDueDate: "2026-11-25", assignmentMode: "shared", status: "due", ...audit },
      { id: "task-other-fixture", title: "Service test kettle", source: "manual", assetId: "synthetic-kitchen",
        dueDate: "2026-11-25", originalDueDate: "2026-11-25", assignmentMode: "shared", status: "due", ...audit },
    ]).run();
  });
});

afterEach(() => db.close());

describe("immersive equipment and recorded maintenance", () => {
  it("finds documented semantic targets and lists only known downstream fixtures", () => {
    writeTx(db.db, (tx) => {
      tx.insert(modelRevision).values({
        id: "past-fixture-revision", modelId: index.modelId, schemaVersion: "1.0", contentHash: "98765432",
        generatedAtMs: at, importedAtMs: at, nodeCount: 0, coordinateSystemJson: "{}", status: "superseded",
      }).run();
      tx.insert(assetPlacement).values({
        id: "past-kettle-placement", assetId: "synthetic-kitchen", modelRevisionId: "past-fixture-revision", modelNodeId: roomId,
        posX: 2, posY: 1, posZ: 1, ...audit,
      }).run();
      const add = (id: string, name: string, kind: "shutoff" | "terminal") => ({
        id, name, kind, modelRevisionId: "fixture-revision", modelNodeId: roomId, posX: 2, posY: 1, posZ: 1, ...audit,
      });
      tx.insert(infraEndpoint).values([
        add("valve-fixture", "Sulkuventtiili", "shutoff"), add("sink-fixture", "Fixture sink", "terminal"),
        add("tap-fixture", "Uncertain fixture", "terminal"), add("electric-fixture", "Unrelated stop switch", "shutoff"),
        add("stale-sink-fixture", "Stale sink", "terminal"),
        { ...add("stale-valve-fixture", "Water shutoff in old model", "shutoff"), modelRevisionId: "past-fixture-revision" },
      ]).run();
      tx.insert(infraRoute).values([
        { id: "line-water", name: "Known cold line", medium: "cold_water", fromEndpointId: "valve-fixture",
          toEndpointId: "sink-fixture", modelRevisionId: "fixture-revision", flowBasis: "declared", flowDirection: "forward", ...audit },
        { id: "line-maybe", name: "Inferred branch", medium: "cold_water", fromEndpointId: "valve-fixture",
          toEndpointId: "tap-fixture", modelRevisionId: "fixture-revision", flowBasis: "inferred", flowDirection: "forward", ...audit },
        { id: "line-stale", name: "Superseded cold branch", medium: "cold_water", fromEndpointId: "valve-fixture",
          toEndpointId: "stale-sink-fixture", modelRevisionId: "past-fixture-revision", flowBasis: "declared", flowDirection: "forward", ...audit },
      ]).run();
    });
    const shutoffs = findHeadsetEquipment(db.db, index, { purpose: "water_shutoff" });
    expect(shutoffs.items).toMatchObject([{ id: "valve-fixture", roomId, position: [2, 1, 1],
      routeIds: ["line-water", "line-maybe"],
      servedFixtures: [{ id: "sink-fixture", name: "Fixture sink" }] }]);
    expect(shutoffs.items).toHaveLength(1);
    expect(findHeadsetEquipment(db.db, index, { purpose: "ventilation_filter" }).items)
      .toMatchObject([{ id: equipmentId, placementId, modelName: "Fixture 50" }]);
    expect(findHeadsetEquipment(db.db, index, { q: "KETTLE" }).items).toMatchObject([{ id: "synthetic-kitchen", position: null, placementId: null }]);
    expect(() => headsetEquipmentByPlacement(db.db, index, "past-kettle-placement")).toThrow("unknown_headset_equipment");
    expect(findHeadsetEquipment(db.db, index, { onlyRoom: true, roomId }).items).toHaveLength(1);
  });

  it("falls back to documented air handlers only when the filter query has no exact match", () => {
    writeTx(db.db, (tx) => {
      tx.insert(asset).values([
        { id: "fixture-air-handler", name: "Fixture machinery", category: "hvac", status: "installed", ...audit },
        { id: "fixture-grille", name: "Fixture air register", category: "hvac", status: "installed", ...audit },
      ]).run();
      tx.insert(assetPlacement).values({
        id: "fixture-air-handler-placement", assetId: "fixture-air-handler", symbol: "ventilation_machine",
        modelRevisionId: "fixture-revision", modelNodeId: roomId, posX: 2, posY: 1, posZ: 1, ...audit,
      }).run();
    });
    const search = () => findHeadsetEquipment(db.db, index, { purpose: "ventilation_filter" }).items;
    expect(search().map(({ id, finding }) => ({ id, finding }))).toEqual([{ id: equipmentId, finding: undefined }]);
    writeTx(db.db, (tx) => tx.delete(assetConsumable).where(eq(assetConsumable.assetId, equipmentId)).run());
    expect(search()).toMatchObject([
      { id: "fixture-air-handler", placementId: "fixture-air-handler-placement", position: [2, 1, 1], finding: "air_handler_filter_unrecorded" },
      { id: equipmentId, finding: "air_handler_filter_unrecorded" },
    ]);
  });

  it("returns the frozen instructions, only the linked manual pages and real stock", () => {
    writeTx(db.db, (tx) => {
      tx.insert(attachment).values({
        id: "manual-fixture", kind: "manual", mime: "application/pdf", byteSize: 123,
        sha256: "synthetic-hash", storagePath: "synthetic.pdf", originalFilename: "Fixture Manual.pdf", ...audit,
      }).run();
      tx.insert(attachmentLink).values({ id: "manual-link", attachmentId: "manual-fixture", entityKind: "asset", entityId: equipmentId }).run();
      tx.insert(procedureReference).values({ id: "manual-page", versionId: "frozen-fixture",
        kind: "page", label: "Filter diagram", manualName: "Fixture Manual", pageFrom: 2, pageTo: 3 }).run();
    });
    const overview = headsetMaintenanceOverview(db.db, index, placementId);
    expect(overview.tasks).toMatchObject([{ id: taskId }]);
    expect(overview.lastWork).toBeNull();
    expect(overview.parts).toMatchObject([{ spec: "Synthetic 250 mm", stockMilli: 0, lastUseDate: null }]);
    const task = headsetTask(db.db, equipmentId, taskId);
    expect(task.procedure?.steps.map(({ id }) => id)).toEqual(["step-fixture"]);
    expect(task.illustrations).toMatchObject([{ stepId: null, previews: [
      { attachmentId: "manual-fixture", kind: "pdf", page: 2 }, { attachmentId: "manual-fixture", kind: "pdf", page: 3 },
    ] }]);
    expect(task.materials).toMatchObject([{ availableMilli: 0, expectedQtyMilli: 1000 }]);
    expect(() => headsetTask(db.db, equipmentId, "task-other-fixture")).toThrow("unknown_headset_task");
  });

  it("requires scoped procedure evidence and completes with ledger changes only once", () => {
    const write = (input: unknown) => writeHeadsetTask(db.db, ctx, index, placementId, headsetTaskWrite.parse(input));
    const requestId = randomUUID();
    const confirm = { kind: "complete", occurrenceId: taskId, requestId, confirmed: true, outcome: "done",
      materials: [{ partId: filterId, actualQtyMilli: 1000 }] };
    expect(() => write({ ...confirm, occurrenceId: "task-other-fixture" })).toThrow("unknown_headset_task");
    expect(() => write(confirm)).toThrow("headset_required_step");
    expect(() => write({ kind: "step", occurrenceId: taskId, stepId: "other-step", state: "done" })).toThrow("unknown_headset_step");
    write({ kind: "step", occurrenceId: taskId, stepId: "step-fixture", state: "done" });
    expect(() => write(confirm)).toThrow("headset_checklist_value_required");
    expect(() => write({ kind: "checklist", occurrenceId: taskId, itemId: "measure-fixture", state: "done", value: "10" }))
      .toThrow("headset_checklist_value_required");
    write({ kind: "checklist", occurrenceId: taskId, itemId: "measure-fixture", state: "done", value: 0 });
    expect(() => write(confirm)).toThrow(/insufficient stock/);
    expect(db.db.select().from(completion).all()).toHaveLength(0);
    const resolved = { ...confirm, materials: [{ partId: filterId, actualQtyMilli: 1000, resolutionIfShort: "adjust_up" }] };
    const recorded = write(resolved);
    expect(recorded).toMatchObject({ completionId: expect.any(String), replayed: false });
    expect(write(resolved)).toMatchObject({ completionId: ("completionId" in recorded ? recorded.completionId : null), replayed: true });
    expect(db.db.select().from(completion).all()).toHaveLength(1);
    expect(db.db.select().from(stockTransaction).all()).toHaveLength(2);
    expect(availableMilli(db.db, filterId)).toBe(0);
    expect(headsetMaintenanceOverview(db.db, index, placementId).lastWork).toMatchObject({ title: "Change intake filter" });
    expect(headsetMaintenanceOverview(db.db, index, placementId).parts[0]?.lastReplacementDate).toBe("2026-11-25");
  });
});
