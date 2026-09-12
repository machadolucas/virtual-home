import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/auth/session", () => ({ requireSession: async () => ({ user: { id: "01900000-0000-7000-8000-000000000001" } }), requireFreshSession: async () => ({ user: { id: "01900000-0000-7000-8000-000000000001" } }), UnauthorizedError: class extends Error {} }));
import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { completion, maintenanceOccurrence, maintenancePlan, serviceBooking } from "@/db/schema";
import { createProviderRecord, updateProviderRecord, archiveProviderRecord, getProvider, listProviders } from "@/server/services/providers";
import { bookProfessional, updateBooking } from "@/server/actions/maintenance/bookings";
import { searchLinkCandidates } from "@/server/queries/infrastructure/linkSearch";
import { loadHistory, parseHistoryFilters } from "@/server/queries/maintenance/history";
import { searchRecords } from "@/server/queries/search";
import { instantOf } from "@/domain/time";
import { type DomainCtx } from "@/domain/occurrence";
import { seedAsset, setupHarness, teardownHarness, type Harness } from "./harness";
let h: Harness;
const ctx: DomainCtx = { actorUserId: "01900000-0000-7000-8000-000000000001", actorKind: "user", tz: "Europe/Helsinki", clock: { now: () => 1789257600000 } };
beforeEach(async () => { h = await setupHarness(); });
afterEach(() => teardownHarness(h));
const audit = { createdAtMs: 1789257600000, updatedAtMs: 1789257600000, createdBy: "01900000-0000-7000-8000-000000000001", updatedBy: "01900000-0000-7000-8000-000000000001" };
function seedTask(id: string) {
  writeTx(h.handle.db, (tx) => tx.insert(maintenanceOccurrence).values({ id, source: "manual", title: `Inspect ${id}`, status: "due", dueDate: "2026-09-13", originalDueDate: "2026-09-13", assignmentMode: "shared", ...audit }).run());
}
function ok<T>(result: { ok: true; data: T } | { ok: false; error: string }): T { if (!result.ok) throw new Error(result.error); return result.data; }
describe("provider management and professional bookings", () => {
  it("edits and archives providers while retaining booking references and clearing plan defaults", async () => {
    const { providerId } = createProviderRecord(h.handle.db, ctx, { name: "Test plumbing", phone: "123" });
    updateProviderRecord(h.handle.db, ctx, providerId, { name: "Test plumbing", phone: "456", email: "contact@example.test", isPreferred: true });
    expect(getProvider(h.handle.db, providerId).phone).toBe("456");
    const assetId = seedAsset(h.handle);
    writeTx(h.handle.db, (tx) => tx.insert(maintenancePlan).values({ id: "plan", title: "Annual inspection", assetId, assignmentMode: "shared", scheduleKind: "one_off", recurrenceJson: '{"v":1,"kind":"one_off"}', defaultProviderId: providerId, ...audit }).run());
    seedTask("first");
    const { bookingId } = ok(await bookProfessional({ occurrenceId: "first", providerId }));
    archiveProviderRecord(h.handle.db, ctx, providerId, true);
    expect(listProviders(h.handle.db)).toHaveLength(0);
    expect(listProviders(h.handle.db, true)).toHaveLength(1);
    expect(h.handle.db.select().from(serviceBooking).where(eq(serviceBooking.id, bookingId)).get()?.providerId).toBe(providerId);
    expect(h.handle.db.select().from(maintenancePlan).get()?.defaultProviderId).toBeNull();
    seedTask("second");
    expect(await bookProfessional({ occurrenceId: "second", providerId })).toMatchObject({ ok: false, error: "provider_archived" });
    archiveProviderRecord(h.handle.db, ctx, providerId, false);
    expect(listProviders(h.handle.db)).toHaveLength(1);
  });
  it("reschedules wall times and refuses cancelling another task's booking without changes", async () => {
    const { providerId } = createProviderRecord(h.handle.db, ctx, { name: "Test electrician" });
    seedTask("first"); seedTask("second");
    const first = ok(await bookProfessional({ occurrenceId: "first", providerId, scheduledDate: "2026-10-23", startTime: "09:30", endTime: "11:00" }));
    const second = ok(await bookProfessional({ occurrenceId: "second", providerId }));
    expect(await updateBooking({ bookingId: first.bookingId, occurrenceId: "second", status: "cancelled" })).toMatchObject({ ok: false, error: "booking_mismatch" });
    expect(h.handle.db.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, "second")).get()?.serviceBookingId).toBe(second.bookingId);
    ok(await updateBooking({ bookingId: first.bookingId, occurrenceId: "first", status: "rescheduled", scheduledDate: "2026-10-26" }));
    const changed = h.handle.db.select().from(serviceBooking).where(eq(serviceBooking.id, first.bookingId)).get()!;
    expect(changed.scheduledStartMs).toBe(instantOf("2026-10-26", "09:30", ctx.tz));
    expect(changed.scheduledEndMs).toBe(instantOf("2026-10-26", "11:00", ctx.tz));
    expect(h.handle.db.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, "first")).get()?.status).toBe("due");
  });
  it("opens an exact old voided completion even after its task was reopened", () => {
    seedTask("reopened");
    writeTx(h.handle.db, (tx) => tx.insert(completion).values({ id: "old-completion", requestId: "old-request", occurrenceId: "reopened", completedAtMs: 1789257600000, completedLocalDate: "2026-09-13", performedByUserId: ctx.actorUserId, voidedAtMs: 1789257600001, voidedBy: ctx.actorUserId, voidReason: "Wrong record", ...audit }).run());
    const filters = parseHistoryFilters(new URLSearchParams("completion=old-completion"));
    const rows = loadHistory(h.handle.db, filters);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: "old-completion", type: "voided", voidReason: "Wrong record" });
    expect(searchLinkCandidates(h.handle.db, "completion", "reopened").candidates[0]?.label).toContain("Voided");
  });
  it("searches task and provider names, and pages relation choices without raw ids", () => {
    createProviderRecord(h.handle.db, ctx, { name: "House plumber", trade: "Plumbing" });
    for (let n = 0; n < 28; n++) seedTask(`pump-${String(n).padStart(2, "0")}`);
    const first = searchLinkCandidates(h.handle.db, "occurrence", "pump"), second = searchLinkCandidates(h.handle.db, "occurrence", "pump", 25);
    expect(first.candidates).toHaveLength(25); expect(first.hasMore).toBe(true);
    expect(second.candidates).toHaveLength(3); expect(second.hasMore).toBe(false);
    expect(first.candidates.map(r => r.id).some(id => second.candidates.some(r => r.id === id))).toBe(false);
    expect(searchLinkCandidates(h.handle.db, "occurrence", "%%").candidates).toHaveLength(0);
    expect(searchRecords(h.handle.db, "plumbing").find(g => g.kind === "providers")?.hits[0]?.label).toBe("House plumber");
    expect(searchRecords(h.handle.db, "pump", { kind: "tasks", limit: 25, offset: 25 })[0]?.hits).toHaveLength(3);
  });
});
