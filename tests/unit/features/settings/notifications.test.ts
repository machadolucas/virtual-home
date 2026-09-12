import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const auth = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/server/auth/session", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError, requireSession: async () => { if (!auth.allowed) throw new UnauthorizedError(); return { user: { id: "first-user" } }; } };
});
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { appAlert, mcpConnection, mcpRequest } from "@/db/schema";
import { notificationSnapshot } from "@/server/queries/notifications";
import { readAlerts } from "@/server/queries/settings/system";
import { GET } from "@/app/api/notifications/route";
import { seedUser, testDb } from "../../../helpers/db";
let handle: DbHandle;
const now = 1790000000000;
beforeEach(() => {
  auth.allowed = true;
  handle = testDb(); setDbForTests(handle);
  seedUser(handle, { id: "first-user", username: "first", name: "First member" });
  seedUser(handle, { id: "second-user", username: "second", name: "Second member" });
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => { vi.restoreAllMocks(); setDbForTests(null); handle.close(); });
function alerts(number: number, options: { seen?: boolean; resolved?: boolean; prefix?: string; timestamp?: number } = {}) {
  writeTx(handle.db, tx => {
    for (let n = 0; n < number; n++) {
      const id = `${options.prefix ?? "alert"}-${String(n).padStart(4, "0")}`;
      tx.insert(appAlert).values({ id, kind: "low_stock", severity: "warning", title: id, dedupeKey: id, firstSeenAtMs: options.timestamp ?? now, lastSeenAtMs: options.timestamp ?? now, acknowledgedAtMs: options.seen ? now : null, acknowledgedBy: options.seen ? "first-user" : null, resolvedAtMs: options.resolved ? now : null }).run();
    }
  });
}
function request(options: { id: string; userId?: string; revoked?: boolean; expiredConnection?: boolean; expiredRequest?: boolean; state?: "pending" | "approved" }) {
  writeTx(handle.db, tx => {
    tx.insert(mcpConnection).values({ id: options.id, userId: options.userId ?? "first-user", name: options.id, tokenHash: options.id, tokenPrefix: options.id, scopesJson: "[]", createdAtMs: now - 1000, expiresAtMs: options.expiredConnection ? now - 1 : now + 10000, revokedAtMs: options.revoked ? now - 1 : null }).run();
    tx.insert(mcpRequest).values({ id: options.id, connectionId: options.id, operation: "test", payloadJson: "{}", summary: "Test request", state: options.state ?? "pending", createdAtMs: now - 1000, expiresAtMs: options.expiredRequest ? now - 1 : now + 10000 }).run();
  });
}
describe("notification paging and filtering", () => {
  it("finds old unseen alerts behind more than a hundred newer acknowledged alerts", () => {
    alerts(120, { seen: true, prefix: "seen" });
    alerts(3, { prefix: "unseen", timestamp: now - 100000 });
    const compact = notificationSnapshot({ limit: 8 });
    expect(compact.alerts.map(a => a.id)).toEqual(["unseen-0000", "unseen-0001", "unseen-0002"]);
    expect(compact.total).toBe(3); expect(compact.unseen).toBe(3);
    expect(compact.hasNext).toBe(false);
    expect(readAlerts(handle.db)).toHaveLength(25);
    expect(readAlerts(handle.db)[0]?.acknowledgedAtMs).toBe(now);
  });
  it("reaches every alert across stable bounded pages without duplicates", () => {
    alerts(120); alerts(2, { resolved: true, prefix: "resolved" });
    const first = notificationSnapshot({ page: 1 }), second = notificationSnapshot({ page: 2 }), third = notificationSnapshot({ page: 3 });
    expect([first.alerts.length, second.alerts.length, third.alerts.length]).toEqual([50, 50, 20]);
    expect(first.hasPrevious).toBe(false); expect(first.hasNext).toBe(true);
    expect(third.hasPrevious).toBe(true); expect(third.hasNext).toBe(false);
    const ids = [...first.alerts, ...second.alerts, ...third.alerts].map(a => a.id);
    expect(new Set(ids).size).toBe(120);
    expect(first.total).toBe(120);
    expect(notificationSnapshot({ page: 99 }).page).toBe(3);
    expect(notificationSnapshot({ limit: 8 }).alerts).toHaveLength(8);
  });
  it("applies include-acknowledged before paging while keeping unseen badge count independent", () => {
    alerts(60, { seen: true, prefix: "seen" }); alerts(2, { prefix: "unseen" });
    const all = notificationSnapshot({ includeAcknowledged: true, page: 2 });
    expect(all.total).toBe(62); expect(all.alerts).toHaveLength(12); expect(all.unseen).toBe(2);
    const unseen = notificationSnapshot({ page: 2 });
    expect(unseen.page).toBe(1); expect(unseen.total).toBe(2); expect(unseen.alerts.every(a => a.acknowledgedAtMs === null)).toBe(true);
  });
  it("counts pending changes for both equal household members and excludes inactive requests", () => {
    request({ id: "first" }); request({ id: "second", userId: "second-user" });
    request({ id: "revoked", revoked: true }); request({ id: "old-connection", expiredConnection: true });
    request({ id: "expired-request", expiredRequest: true }); request({ id: "approved", state: "approved" });
    expect(notificationSnapshot().pending).toBe(2);
  });
  it("validates API bounds and keeps notifications authenticated and private", async () => {
    alerts(60);
    const get = (query: string) => GET(new Request(`http://localhost/api/notifications?${query}`), {});
    const response = await get("page=2&limit=50&includeAcknowledged=0");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ page: 2, total: 60, hasNext: false });
    expect((await get("limit=5000")).status).toBe(400);
    expect((await get("page=-1")).status).toBe(400);
    expect((await get("includeAcknowledged=yes")).status).toBe(400);
    auth.allowed = false; expect((await get("limit=8")).status).toBe(401);
  });
});
